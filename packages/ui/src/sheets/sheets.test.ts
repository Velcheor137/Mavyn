import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ExcelJS from 'exceljs';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { readCsv, writeCsv } from './csv.ts';
import { FormulaEngine } from './formulas.ts';
import { formatValue, getCell, setCell, shiftRows, type Workbook } from './model.ts';
import { fromOpenFormula, readOds, toOpenFormula, writeOds } from './ods.ts';
import { readXlsx, unsupportedParts, writeXlsx } from './xlsx.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(resolve(__dirname, '../../../../tests/fixtures/files', name)));

async function excelBytes(build: (wb: ExcelJS.Workbook) => void): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

async function reread(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes.slice().buffer as ArrayBuffer);
  return wb;
}

describe('csv', () => {
  it('detects the delimiter and keeps cell text exactly', () => {
    const text = 'Имя;Сумма;Заметка\r\nАня;1,50;"с ""кавычками"""\r\nБорис;007;"две\r\nстроки"\r\n';
    const { book, dialect } = readCsv(text, 'data.csv');
    expect(dialect).toEqual({ delimiter: ';', lineEnding: '\r\n', finalNewline: true });
    const sheet = book.sheets[0]!;
    expect(getCell(sheet, 1, 1)?.v).toBe('1,50');
    expect(getCell(sheet, 2, 1)?.v).toBe('007');
    expect(getCell(sheet, 2, 2)?.v).toBe('две\r\nстроки');
    expect(writeCsv(book, dialect)).toBe(text);
  });

  it('writes edits back with quoting and TSV by extension', () => {
    const { book, dialect } = readCsv('a\tb\n1\t2\n', 'x.tsv');
    expect(dialect.delimiter).toBe('\t');
    setCell(book.sheets[0]!, 1, 2, { v: 'new, "quoted"', edited: true });
    expect(writeCsv(book, dialect)).toBe('a\tb\t\n1\t2\tnew, "quoted"\n'.replace('new, "quoted"', '"new, ""quoted"""'));
  });
});

describe('formula engine', () => {
  it('recalculates and adjusts references when rows are inserted', async () => {
    const { book } = readCsv('', 'x.csv');
    const sheet = book.sheets[0]!;
    setCell(sheet, 0, 0, { v: 2 });
    setCell(sheet, 1, 0, { v: 3 });
    setCell(sheet, 2, 0, { v: null, f: '=SUM(A1:A2)' });
    const engine = await FormulaEngine.create(book);
    expect(engine.value(0, 2, 0)).toBe(5);
    engine.setContent(0, 0, 0, 10);
    expect(engine.value(0, 2, 0)).toBe(13);
    engine.insertRows(0, 1, 1);
    shiftRows(sheet, 1, 1);
    engine.syncInto(book);
    expect(getCell(sheet, 3, 0)).toMatchObject({ f: '=SUM(A1:A3)', v: 13, edited: true });
    setCell(sheet, 4, 0, { v: null, f: '=NOSUCHFUNCTION(1)' });
    engine.setContent(0, 4, 0, '=NOSUCHFUNCTION(1)');
    expect(engine.hasUnknownFunctions(book)).toBe(true);
    engine.destroy();
  });

  it('formats common number formats', () => {
    expect(formatValue(0.256, '0.0%', 'en')).toBe('25.6%');
    expect(formatValue(1234.5, '#,##0.00', 'en')).toBe('1,234.50');
    expect(formatValue(45000, 'dd.mm.yyyy', 'en-GB')).toBe('15/03/2023');
  });
});

describe('xlsx', () => {
  it('reads values, formulas, merges, sizes and styles from the fixture', async () => {
    const { book, unsupported } = await readXlsx(fixture('sample.xlsx'));
    expect(unsupported).toEqual([]);
    expect(book.sheets.map((s) => s.name)).toEqual(['Отчёт', 'Second']);
    const sheet = book.sheets[0]!;
    expect(getCell(sheet, 0, 0)?.v).toBe('Квартальный отчёт');
    expect(getCell(sheet, 4, 2)).toMatchObject({ f: '=SUM(C3:C4)', v: 225 });
    expect(sheet.merges).toEqual([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
  });

  it('writes edits and restyled cells while untouched styling survives', async () => {
    const bytes = await excelBytes((wb) => {
      const ws = wb.addWorksheet('Data');
      ws.getCell('A1').value = 'Title';
      ws.getCell('A1').font = { bold: true, color: { theme: 4 } };
      ws.getCell('B2').value = 2;
      ws.getCell('B3').value = 3;
      ws.getCell('B4').value = { formula: 'SUM(B2:B3)', result: 5 };
      ws.getCell('C1').value = 'kept';
      ws.mergeCells('A6:B6');
      ws.getColumn(1).width = 30;
      ws.pageSetup.orientation = 'landscape';
    });
    const { book, context, unsupported } = await readXlsx(bytes);
    expect(unsupported).toEqual([]);
    const sheet = book.sheets[0]!;
    setCell(sheet, 1, 1, { ...getCell(sheet, 1, 1)!, v: 40, edited: true });
    setCell(sheet, 2, 1, { ...getCell(sheet, 2, 1)!, s: { fill: '#FFEE00', bold: true }, restyled: true });
    const engine = await FormulaEngine.create(book);
    engine.refreshValues(book, 0);
    expect(getCell(sheet, 3, 1)?.v).toBe(43);
    const out = await reread(await writeXlsx(book, context));
    const ws = out.getWorksheet('Data')!;
    expect(ws.getCell('B2').value).toBe(40);
    expect(ws.getCell('B4').value).toMatchObject({ formula: 'SUM(B2:B3)', result: 43 });
    expect(ws.getCell('B3').fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEE00' } });
    expect(ws.getCell('B3').font?.bold).toBe(true);
    // Untouched: theme colour, merge, column width, page setup.
    expect(ws.getCell('A1').font).toMatchObject({ bold: true, color: { theme: 4 } });
    expect(ws.model.merges).toContain('A6:B6');
    expect(ws.getColumn(1).width).toBe(30);
    expect(ws.pageSetup.orientation).toBe('landscape');
    engine.destroy();
  });

  it('reports parts a save would lose', async () => {
    const files = unzipSync(fixture('sample.xlsx'));
    files['xl/charts/chart1.xml'] = strToU8('<c:chartSpace/>');
    files['xl/vbaProject.bin'] = new Uint8Array([1]);
    expect(unsupportedParts(zipSync(files)).sort()).toEqual(['charts', 'macros']);
  });
});

describe('ods', () => {
  it('converts formulas between OpenFormula and Excel syntax', () => {
    expect(fromOpenFormula('of:=SUM([.C3:.C4])')).toBe('=SUM(C3:C4)');
    expect(fromOpenFormula("of:=IF([.A1]>0;[$'Лист 2'.B2];\"a;b\")")).toBe("=IF(A1>0,'Лист 2'!B2,\"a;b\")");
    expect(toOpenFormula('=SUM(C3:C4)')).toBe('of:=SUM([.C3:.C4])');
    expect(toOpenFormula("=IF(A1>0,'Лист 2'!B2,\"a,b\")")).toBe("of:=IF([.A1]>0;['Лист 2'.B2];\"a,b\")");
  });

  it('reads the fixture and writes edits back, keeping untouched cells and other parts', () => {
    const original = fixture('sample.ods');
    const { book, context, unsupported } = readOds(original);
    expect(unsupported).toEqual([]);
    const sheet = book.sheets[0]!;
    expect(getCell(sheet, 0, 0)?.v).toBe('Квартальный отчёт');
    expect(sheet.merges).toContainEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
    expect(getCell(sheet, 2, 1)?.v).toBe(100);
    setCell(sheet, 2, 1, { ...getCell(sheet, 2, 1)!, v: 111, edited: true });
    setCell(sheet, 3, 0, { ...getCell(sheet, 3, 0)!, s: { bold: true, fill: '#FFCC00' }, restyled: true });
    setCell(sheet, 6, 3, { v: 'новая  ячейка', edited: true });
    const written = writeOds(book, context);
    const parts = unzipSync(written);
    expect(Object.keys(parts)[0]).toBe('mimetype');
    expect(parts['styles.xml']).toEqual(unzipSync(original)['styles.xml']);
    const again = readOds(written).book.sheets[0]!;
    expect(getCell(again, 2, 1)?.v).toBe(111);
    expect(getCell(again, 3, 0)?.s).toMatchObject({ bold: true, fill: '#FFCC00' });
    expect(getCell(again, 6, 3)?.v).toBe('новая  ячейка');
    expect(getCell(again, 0, 0)?.v).toBe('Квартальный отчёт');
    expect(again.merges).toContainEqual({ r1: 0, c1: 0, r2: 0, c2: 2 });
  });

  it('writes the recalculated result of an untouched formula whose inputs changed', async () => {
    const { book, context } = readOds(fixture('sample.ods'));
    const sheet = book.sheets[0]!;
    expect(getCell(sheet, 4, 2)).toMatchObject({ f: '=SUM(C3:C4)', v: 225 });
    const engine = await FormulaEngine.create(book);
    setCell(sheet, 3, 2, { ...getCell(sheet, 3, 2)!, v: 200, edited: true });
    engine.setContent(0, 3, 2, 200);
    engine.refreshValues(book, 0);
    engine.destroy();
    const again = readOds(writeOds(book, context)).book.sheets[0]!;
    expect(getCell(again, 4, 2)).toMatchObject({ f: '=SUM(C3:C4)', v: 295 });
  });
});

describe('model', () => {
  it('moves merges and sizes with inserted and deleted rows', () => {
    const book: Workbook = readCsv('a\nb\nc\n', 'x.csv').book;
    const sheet = book.sheets[0]!;
    sheet.merges = [{ r1: 1, c1: 0, r2: 2, c2: 1 }];
    sheet.rowHeights.set(2, 30);
    shiftRows(sheet, 0, 2);
    expect(sheet.merges).toEqual([{ r1: 3, c1: 0, r2: 4, c2: 1 }]);
    expect(sheet.rowHeights.get(4)).toBe(30);
    expect(getCell(sheet, 2, 0)?.v).toBe('a');
    // Deleting one of its rows shrinks the merge; deleting all of them removes it.
    shiftRows(sheet, 3, -1);
    expect(sheet.merges).toEqual([{ r1: 3, c1: 0, r2: 3, c2: 1 }]);
    shiftRows(sheet, 3, -1);
    expect(sheet.merges).toEqual([]);
  });
});
