//! Plain text of binary documents, for API clients and MCP tools that read them: docx as Markdown-ish
//! text (headings, lists, tables), xlsx/ods as one Markdown table per sheet, pdf as text per page.
//! Read-only: files are always written back as whole files.
//!
//! The bytes come from users, so parsing runs on a blocking thread with a timeout, panics are caught,
//! zip containers are checked against a decompression budget before anything is inflated, and the
//! result is capped.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::time::Duration;

/// Total uncompressed size of the zip entries a parser may read (zip-bomb guard).
const MAX_UNPACKED: u64 = 100 * 1024 * 1024;
/// Longest text returned; the rest is dropped and `truncated` is set.
pub const MAX_TEXT: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extracted {
    /// `"docx"`, `"xlsx"`, `"ods"` or `"pdf"`.
    pub format: &'static str,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtractError {
    /// Not one of the supported formats.
    Unsupported,
    /// A supported format that could not be parsed (damaged, encrypted, too large unpacked, …).
    Unreadable(String),
    TimedOut,
}

impl std::fmt::Display for ExtractError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExtractError::Unsupported => f.write_str("unsupported file type"),
            ExtractError::Unreadable(reason) => write!(f, "file could not be read: {reason}"),
            ExtractError::TimedOut => f.write_str("reading the file took too long"),
        }
    }
}

fn unreadable(error: impl std::fmt::Display) -> ExtractError {
    ExtractError::Unreadable(error.to_string())
}

/// [`extract`] on a blocking thread, with a timeout and panic isolation.
pub async fn extract_async(bytes: Vec<u8>) -> Result<Extracted, ExtractError> {
    let task = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| extract(&bytes)).unwrap_or_else(|_| {
            Err(ExtractError::Unreadable(
                "the parser failed on this file".into(),
            ))
        })
    });
    match tokio::time::timeout(TIMEOUT, task).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(ExtractError::Unreadable(
            "the parser failed on this file".into(),
        )),
        // The blocking thread finishes on its own; its result is dropped.
        Err(_) => Err(ExtractError::TimedOut),
    }
}

/// Detects the format from the bytes (not from a declared MIME type) and extracts its text.
pub fn extract(bytes: &[u8]) -> Result<Extracted, ExtractError> {
    if bytes.starts_with(b"%PDF-") {
        return finish("pdf", pdf_text(bytes)?);
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(ExtractError::Unsupported);
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(unreadable)?;
    let mut unpacked: u64 = 0;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(unreadable)?;
        unpacked = unpacked.saturating_add(entry.size());
    }
    if unpacked > MAX_UNPACKED {
        return Err(ExtractError::Unreadable(format!(
            "unpacked size exceeds {} MiB",
            MAX_UNPACKED / 1024 / 1024
        )));
    }
    let has = |zip: &zip::ZipArchive<Cursor<&[u8]>>, name: &str| zip.index_for_name(name).is_some();
    if has(&zip, "word/document.xml") {
        let styles = match read_entry(&mut zip, "word/styles.xml") {
            Ok(xml) => heading_styles(&xml),
            Err(_) => HashMap::new(),
        };
        let document = read_entry(&mut zip, "word/document.xml")?;
        return finish("docx", docx_text(&document, &styles)?);
    }
    if has(&zip, "xl/workbook.xml") {
        let workbook: calamine::Xlsx<_> =
            calamine::open_workbook_from_rs(Cursor::new(bytes)).map_err(unreadable)?;
        return finish("xlsx", render_sheets(&xlsx_sheets(workbook)));
    }
    if has(&zip, "content.xml") {
        let mimetype = read_entry(&mut zip, "mimetype").unwrap_or_default();
        if mimetype.trim() == "application/vnd.oasis.opendocument.spreadsheet" {
            // Own reader: calamine's rejects whitespace between cells (pretty-printed content.xml).
            let content = read_entry(&mut zip, "content.xml")?;
            return finish("ods", render_sheets(&ods_sheets(&content)?));
        }
    }
    Err(ExtractError::Unsupported)
}

fn finish(format: &'static str, mut text: String) -> Result<Extracted, ExtractError> {
    let truncated = text.len() > MAX_TEXT;
    if truncated {
        let mut end = MAX_TEXT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    Ok(Extracted {
        format,
        text,
        truncated,
    })
}

fn read_entry(
    zip: &mut zip::ZipArchive<Cursor<&[u8]>>,
    name: &str,
) -> Result<String, ExtractError> {
    let entry = zip.by_name(name).map_err(unreadable)?;
    let mut text = String::new();
    // The central directory may lie about sizes: never inflate more than the budget.
    entry
        .take(MAX_UNPACKED)
        .read_to_string(&mut text)
        .map_err(unreadable)?;
    Ok(text)
}

// --- pdf ---------------------------------------------------------------------------------------

fn pdf_text(bytes: &[u8]) -> Result<String, ExtractError> {
    let pages = pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(unreadable)?;
    let mut out = String::new();
    for (i, page) in pages.iter().enumerate() {
        if out.len() > MAX_TEXT {
            break;
        }
        out.push_str(&format!("--- page {} ---\n", i + 1));
        out.push_str(page.trim());
        out.push_str("\n\n");
    }
    Ok(out)
}

// --- xlsx / ods --------------------------------------------------------------------------------

/// Cap on rows and columns read from one sheet (repeated empty rows/cells are never expanded).
const MAX_ROWS: usize = 100_000;
const MAX_COLUMNS: usize = 16_384;

struct Sheet {
    name: String,
    /// Zero-based row and column of the first cell in `rows`.
    start: (usize, usize),
    rows: Vec<Vec<String>>,
}

fn xlsx_sheets<RS, R>(mut workbook: R) -> Vec<Sheet>
where
    RS: std::io::Read + std::io::Seek,
    R: calamine::Reader<RS>,
{
    workbook
        .worksheets()
        .into_iter()
        .map(|(name, range)| {
            let (row, col) = range.start().unwrap_or((0, 0));
            Sheet {
                name,
                start: (row as usize, col as usize),
                rows: range
                    .rows()
                    .take(MAX_ROWS)
                    .map(|r| r.iter().take(MAX_COLUMNS).map(cell_text).collect())
                    .collect(),
            }
        })
        .collect()
}

/// Sheets of an ODS `content.xml`: typed values from `office:*-value` attributes, otherwise the
/// cell's paragraphs. Repeated rows and cells expand only when something non-empty follows them.
fn ods_sheets(xml: &str) -> Result<Vec<Sheet>, ExtractError> {
    let mut reader = Reader::from_str(xml);
    let mut sheets = Vec::new();
    let mut sheet: Option<Sheet> = None;
    let mut pending_rows = 0usize;
    let mut row: Vec<String> = Vec::new();
    let mut row_repeat = 1usize;
    let mut pending_cells = 0usize;
    let mut cell: Option<(String, usize, Option<String>)> = None; // (text, repeat, typed value)
    let mut paragraphs = 0usize;

    fn repeat(e: &quick_xml::events::BytesStart<'_>, name: &str) -> usize {
        attr(e, name)
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1)
            .clamp(1, MAX_ROWS.max(MAX_COLUMNS))
    }
    fn typed_value(e: &quick_xml::events::BytesStart<'_>) -> Option<String> {
        match attr(e, "office:value-type").as_deref() {
            Some("float" | "percentage" | "currency") => attr(e, "office:value"),
            Some("date") => attr(e, "office:date-value").map(|d| d.replacen('T', " ", 1)),
            Some("time") => attr(e, "office:time-value"),
            Some("boolean") => attr(e, "office:boolean-value"),
            _ => None,
        }
    }
    fn push_cell(row: &mut Vec<String>, pending: &mut usize, value: String, times: usize) {
        if value.is_empty() {
            *pending += times;
            return;
        }
        while *pending > 0 && row.len() < MAX_COLUMNS {
            row.push(String::new());
            *pending -= 1;
        }
        *pending = 0;
        for _ in 0..times {
            if row.len() >= MAX_COLUMNS {
                break;
            }
            row.push(value.clone());
        }
    }

    loop {
        let event = reader.read_event().map_err(unreadable)?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.name().as_ref() {
                    "table:table" if !empty => {
                        sheet = Some(Sheet {
                            name: attr(e, "table:name").unwrap_or_default(),
                            start: (0, 0),
                            rows: Vec::new(),
                        });
                        pending_rows = 0;
                    }
                    "table:table-row" => {
                        row = Vec::new();
                        pending_cells = 0;
                        row_repeat = repeat(e, "table:number-rows-repeated");
                        if empty {
                            pending_rows += row_repeat;
                        }
                    }
                    "table:table-cell" | "table:covered-table-cell" => {
                        let times = repeat(e, "table:number-columns-repeated");
                        let value = typed_value(e);
                        if empty {
                            push_cell(
                                &mut row,
                                &mut pending_cells,
                                value.unwrap_or_default(),
                                times,
                            );
                        } else {
                            cell = Some((String::new(), times, value));
                            paragraphs = 0;
                        }
                    }
                    "text:p" if !empty => {
                        if let Some((text, _, _)) = cell.as_mut() {
                            if paragraphs > 0 {
                                text.push(' ');
                            }
                            paragraphs += 1;
                        }
                    }
                    "text:s" | "text:tab" | "text:line-break" => {
                        if let Some((text, _, _)) = cell.as_mut() {
                            text.push(' ');
                        }
                    }
                    _ => {}
                }
            }
            Event::Text(t) => {
                if let Some((text, _, _)) = cell.as_mut() {
                    if paragraphs > 0 {
                        text.push_str(&t.xml10_content());
                    }
                }
            }
            Event::GeneralRef(r) => {
                if let Some((text, _, _)) = cell.as_mut() {
                    if let Ok(Some(c)) = r.resolve_char_ref() {
                        text.push(c);
                    } else if let Some(s) = predefined_entity(&r) {
                        text.push_str(s);
                    }
                }
            }
            Event::End(e) => match e.name().as_ref() {
                "table:table-cell" | "table:covered-table-cell" => {
                    if let Some((text, times, value)) = cell.take() {
                        let value = value.unwrap_or_else(|| text.trim().to_owned());
                        push_cell(&mut row, &mut pending_cells, value, times);
                    }
                }
                "table:table-row" => {
                    if let Some(sheet) = sheet.as_mut() {
                        if row.is_empty() {
                            pending_rows += row_repeat;
                        } else {
                            while pending_rows > 0 && sheet.rows.len() < MAX_ROWS {
                                sheet.rows.push(Vec::new());
                                pending_rows -= 1;
                            }
                            pending_rows = 0;
                            for _ in 0..row_repeat {
                                if sheet.rows.len() >= MAX_ROWS {
                                    break;
                                }
                                sheet.rows.push(row.clone());
                            }
                        }
                    }
                    row = Vec::new();
                }
                "table:table" => {
                    if let Some(sheet) = sheet.take() {
                        sheets.push(sheet);
                    }
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(sheets)
}

fn render_sheets(sheets: &[Sheet]) -> String {
    let mut out = String::new();
    for sheet in sheets {
        if out.len() > MAX_TEXT {
            break;
        }
        out.push_str(&format!("## {}\n\n", sheet.name));
        let rows = &sheet.rows;
        // Trailing empty columns and rows add nothing.
        let width = rows
            .iter()
            .map(|r| r.iter().rposition(|c| !c.is_empty()).map_or(0, |p| p + 1))
            .max()
            .unwrap_or(0);
        let height = rows
            .iter()
            .rposition(|r| r.iter().any(|c| !c.is_empty()))
            .map_or(0, |p| p + 1);
        if width == 0 || height == 0 {
            out.push_str("(empty sheet)\n\n");
            continue;
        }
        // Column letters and row numbers, so cells can be referred to as in a spreadsheet.
        let (start_row, start_col) = sheet.start;
        let mut header = vec![String::new()];
        header.extend((0..width).map(|c| column_name(start_col + c)));
        push_row(&mut out, &header);
        out.push('|');
        out.push_str(&"---|".repeat(width + 1));
        out.push('\n');
        for (r, row) in rows.iter().take(height).enumerate() {
            if out.len() > MAX_TEXT {
                break;
            }
            let mut cells = vec![(start_row + r + 1).to_string()];
            cells.extend((0..width).map(|c| row.get(c).cloned().unwrap_or_default()));
            push_row(&mut out, &cells);
        }
        out.push('\n');
    }
    out
}

fn push_row(out: &mut String, cells: &[String]) {
    out.push('|');
    for cell in cells {
        out.push(' ');
        out.push_str(&table_cell(cell));
        out.push_str(" |");
    }
    out.push('\n');
}

fn table_cell(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace('|', "\\|")
        .replace(['\r', '\n'], " ")
}

fn column_name(mut index: usize) -> String {
    let mut name = Vec::new();
    loop {
        name.push(b'A' + (index % 26) as u8);
        if index < 26 {
            break;
        }
        index = index / 26 - 1;
    }
    name.reverse();
    String::from_utf8(name).unwrap_or_default()
}

fn cell_text(cell: &calamine::Data) -> String {
    match cell {
        calamine::Data::DateTime(value) if value.is_datetime() => excel_date(value.as_f64()),
        other => other.to_string(),
    }
}

/// Excel serial date (1900 system: day 0 = 1899-12-30) as ISO 8601.
fn excel_date(serial: f64) -> String {
    let Ok(epoch) = time::Date::from_calendar_date(1899, time::Month::December, 30) else {
        return serial.to_string();
    };
    let epoch = epoch.midnight();
    if !serial.is_finite() || !(0.0..2_900_000.0).contains(&serial) {
        return serial.to_string();
    }
    let seconds = (serial * 86_400.0).round() as i64;
    let moment = epoch + time::Duration::seconds(seconds);
    let date = moment.date();
    if seconds % 86_400 == 0 {
        format!(
            "{:04}-{:02}-{:02}",
            date.year(),
            u8::from(date.month()),
            date.day()
        )
    } else {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            date.year(),
            u8::from(date.month()),
            date.day(),
            moment.hour(),
            moment.minute(),
            moment.second()
        )
    }
}

// --- docx --------------------------------------------------------------------------------------

/// Heading level by style id, from `word/styles.xml`. Style ids are localized ("Heading1",
/// "1", "Заголовок1"); the built-in style *names* ("heading 1", "Title") are not.
fn heading_styles(xml: &str) -> HashMap<String, usize> {
    let mut styles = HashMap::new();
    let mut reader = Reader::from_str(xml);
    let mut current: Option<String> = None;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == "w:style" => {
                current = attr(&e, "w:styleId");
            }
            Ok(Event::Empty(e)) if e.name().as_ref() == "w:name" => {
                if let (Some(id), Some(name)) = (&current, attr(&e, "w:val")) {
                    let name = name.to_lowercase();
                    let level = if name == "title" {
                        Some(1)
                    } else {
                        name.strip_prefix("heading ")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                            .filter(|n| (1..=9).contains(n))
                    };
                    if let Some(level) = level {
                        styles.insert(id.clone(), level.min(6));
                    }
                }
            }
            Ok(Event::End(e)) if e.name().as_ref() == "w:style" => current = None,
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    styles
}

fn attr(e: &quick_xml::events::BytesStart<'_>, name: &str) -> Option<String> {
    e.try_get_attribute(name).ok().flatten().and_then(|a| {
        a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
            .ok()
            .map(|v| v.into_owned())
    })
}

/// One paragraph being collected.
#[derive(Default)]
struct Paragraph {
    text: String,
    heading: Option<usize>,
    list_level: Option<usize>,
}

impl Paragraph {
    fn render(&self) -> String {
        let text = self.text.trim();
        if text.is_empty() {
            return String::new();
        }
        match (self.heading, self.list_level) {
            (Some(level), _) => format!("{} {text}", "#".repeat(level)),
            (None, Some(level)) => format!("{}- {text}", "  ".repeat(level.min(8))),
            (None, None) => text.to_owned(),
        }
    }
}

/// Text of `word/document.xml`: paragraphs separated by blank lines, headings as `#`, list items
/// as `-`, tables as Markdown tables (nested tables flattened into their cell), pictures as
/// `[image]`.
fn docx_text(xml: &str, styles: &HashMap<String, usize>) -> Result<String, ExtractError> {
    let mut reader = Reader::from_str(xml);
    let mut out = String::new();
    let mut paragraph = Paragraph::default();
    // Table nesting depth; only the outermost table becomes a Markdown table.
    let mut table_depth = 0usize;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut cell = String::new();
    let mut in_text = false;
    let mut in_del = false;

    loop {
        let event = reader.read_event().map_err(unreadable)?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                let empty = matches!(event, Event::Empty(_));
                match e.name().as_ref() {
                    "w:tbl" if !empty => {
                        table_depth += 1;
                        if table_depth == 1 {
                            rows.clear();
                        }
                    }
                    "w:tr" if table_depth == 1 && !empty => rows.push(Vec::new()),
                    "w:tc" if table_depth == 1 && !empty => cell.clear(),
                    "w:p" if !empty => paragraph = Paragraph::default(),
                    "w:pStyle" => {
                        if let Some(level) = attr(e, "w:val").and_then(|id| styles.get(&id)) {
                            paragraph.heading = Some(*level);
                        }
                    }
                    "w:outlineLvl" => {
                        if let Some(level) = attr(e, "w:val").and_then(|v| v.parse::<usize>().ok())
                        {
                            if level < 9 {
                                paragraph.heading = Some((level + 1).min(6));
                            }
                        }
                    }
                    "w:ilvl" => {
                        paragraph.list_level =
                            Some(attr(e, "w:val").and_then(|v| v.parse().ok()).unwrap_or(0));
                    }
                    "w:numPr" => {
                        paragraph.list_level.get_or_insert(0);
                    }
                    "w:t" if !empty => in_text = true,
                    // Deleted text of tracked changes is not part of the document.
                    "w:del" if !empty => in_del = true,
                    "w:tab" => paragraph.text.push('\t'),
                    "w:br" | "w:cr" => paragraph.text.push(' '),
                    "w:drawing" | "w:pict" => paragraph.text.push_str(" [image] "),
                    _ => {}
                }
            }
            Event::Text(t) if in_text && !in_del => paragraph.text.push_str(&t.xml10_content()),
            Event::GeneralRef(r) if in_text && !in_del => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    paragraph.text.push(c);
                } else if let Some(s) = predefined_entity(&r) {
                    paragraph.text.push_str(s);
                }
            }
            Event::End(e) => match e.name().as_ref() {
                "w:t" => in_text = false,
                "w:del" => in_del = false,
                "w:p" => {
                    let rendered = paragraph.render();
                    if table_depth > 0 {
                        if !rendered.is_empty() {
                            if !cell.is_empty() {
                                cell.push(' ');
                            }
                            cell.push_str(&rendered);
                        }
                    } else if !rendered.is_empty() {
                        out.push_str(&rendered);
                        out.push_str("\n\n");
                    }
                    paragraph = Paragraph::default();
                }
                "w:tc" if table_depth == 1 => {
                    if let Some(row) = rows.last_mut() {
                        row.push(std::mem::take(&mut cell));
                    }
                }
                "w:tbl" => {
                    if table_depth == 1 {
                        render_table(&mut out, &rows);
                    }
                    table_depth = table_depth.saturating_sub(1);
                }
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
        if out.len() > MAX_TEXT {
            break;
        }
    }
    Ok(out)
}

fn predefined_entity(name: &str) -> Option<&'static str> {
    Some(match name {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        _ => return None,
    })
}

fn render_table(out: &mut String, rows: &[Vec<String>]) {
    let width = rows.iter().map(Vec::len).max().unwrap_or(0);
    if width == 0 {
        return;
    }
    for (i, row) in rows.iter().enumerate() {
        let cells: Vec<String> = (0..width)
            .map(|c| row.get(c).cloned().unwrap_or_default())
            .collect();
        push_row(out, &cells);
        if i == 0 {
            out.push('|');
            out.push_str(&"---|".repeat(width));
            out.push('\n');
        }
    }
    out.push('\n');
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn fixture(name: &str) -> Vec<u8> {
        let path = format!(
            "{}/../../tests/fixtures/files/{name}",
            env!("CARGO_MANIFEST_DIR")
        );
        std::fs::read(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
    }

    fn zip_of(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        {
            let mut zip = zip::ZipWriter::new(Cursor::new(&mut out));
            for (name, content) in entries {
                zip.start_file(*name, zip::write::SimpleFileOptions::default())
                    .expect("start");
                zip.write_all(content.as_bytes()).expect("write");
            }
            zip.finish().expect("finish");
        }
        out
    }

    #[test]
    fn fixtures_yield_text() {
        for (name, format) in [
            ("sample.docx", "docx"),
            ("sample.xlsx", "xlsx"),
            ("sample.ods", "ods"),
            ("sample.pdf", "pdf"),
        ] {
            let extracted = extract(&fixture(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(extracted.format, format);
            assert!(!extracted.truncated);
            assert!(
                extracted.text.trim().len() > 3,
                "{name}: {:?}",
                extracted.text
            );
        }
    }

    #[test]
    fn docx_headings_lists_tables_and_tracked_deletions() {
        let styles = r#"<w:styles xmlns:w="w"><w:style w:styleId="1"><w:name w:val="heading 1"/></w:style><w:style w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>"#;
        let document = r#"<w:document xmlns:w="w"><w:body>
            <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>Отчёт &amp; план</w:t></w:r></w:p>
            <w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:del><w:r><w:t>gone</w:t></w:r></w:del><w:r><w:t>world</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
            <w:tbl><w:tr><w:tc><w:p><w:r><w:t>A|B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>
            <w:tr><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:drawing/></w:r></w:p></w:tc></w:tr></w:tbl>
        </w:body></w:document>"#;
        let bytes = zip_of(&[("word/document.xml", document), ("word/styles.xml", styles)]);
        let text = extract(&bytes).expect("docx").text;
        assert_eq!(
            text,
            "# Отчёт & план\n\nHello world\n\n  - item\n\n| A\\|B | 2 |\n|---|---|\n| x | [image] |\n\n"
        );
    }

    #[test]
    fn ods_values_repeats_and_whitespace() {
        let xml = r#"<office:document-content><office:body><office:spreadsheet>
          <table:table table:name="Лист1">
            <table:table-row>
              <table:table-cell office:value-type="string"><text:p>Name</text:p></table:table-cell>
              <table:table-cell table:number-columns-repeated="2"/>
              <table:table-cell office:value-type="float" office:value="12.5"><text:p>12,50</text:p></table:table-cell>
            </table:table-row>
            <table:table-row table:number-rows-repeated="2"><table:table-cell table:number-columns-repeated="1024"/></table:table-row>
            <table:table-row>
              <table:table-cell office:value-type="date" office:date-value="2025-01-02T10:00:00"/>
              <table:table-cell><text:p>a &amp; b</text:p><text:p>c</text:p></table:table-cell>
            </table:table-row>
            <table:table-row table:number-rows-repeated="1048570"><table:table-cell table:number-columns-repeated="16384"/></table:table-row>
          </table:table>
        </office:spreadsheet></office:body></office:document-content>"#;
        let sheets = ods_sheets(xml).expect("ods");
        assert_eq!(sheets.len(), 1);
        assert_eq!(sheets[0].rows.len(), 4);
        assert_eq!(
            render_sheets(&sheets),
            "## Лист1\n\n|  | A | B | C | D |\n|---|---|---|---|---|\n| 1 | Name |  |  | 12.5 |\n| 2 |  |  |  |  |\n| 3 |  |  |  |  |\n| 4 | 2025-01-02 10:00:00 | a & b c |  |  |\n\n"
        );
    }

    #[test]
    fn excel_dates_and_column_names() {
        assert_eq!(excel_date(45_658.0), "2025-01-01");
        assert_eq!(excel_date(45_658.5), "2025-01-01 12:00:00");
        assert_eq!(column_name(0), "A");
        assert_eq!(column_name(25), "Z");
        assert_eq!(column_name(26), "AA");
        assert_eq!(column_name(701), "ZZ");
    }

    #[test]
    fn rejects_unknown_damaged_and_oversized_input() {
        assert_eq!(extract(b"hello"), Err(ExtractError::Unsupported));
        assert!(matches!(
            extract(b"PK\x03\x04garbage"),
            Err(ExtractError::Unreadable(_))
        ));
        assert_eq!(
            extract(&zip_of(&[("readme.txt", "x")])),
            Err(ExtractError::Unsupported)
        );
        // A highly compressible entry larger than the budget is refused before inflating.
        let big = "a".repeat((MAX_UNPACKED + 1) as usize);
        let bomb = zip_of(&[("word/document.xml", &big)]);
        assert!(bomb.len() < 1024 * 1024);
        assert!(matches!(extract(&bomb), Err(ExtractError::Unreadable(_))));
    }

    #[test]
    fn long_text_is_truncated_on_a_char_boundary() {
        let result = finish("pdf", "я".repeat(MAX_TEXT)).expect("finish");
        assert!(result.truncated);
        assert!(result.text.len() <= MAX_TEXT);
    }
}
