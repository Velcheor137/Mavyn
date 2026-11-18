import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { EditorState, TextSelection } from 'prosemirror-state';
import { addColumnAfter } from 'prosemirror-tables';
import { describe, expect, it } from 'vitest';
import { parseDocument, schema, serializeDocument } from './convert.ts';
import { addImage, ensureList, readPackage, writePackage } from './package.ts';

const fixture = () => new Uint8Array(readFileSync(resolve(__dirname, '../../../../tests/fixtures/files/sample.docx')));

function load(bytes = fixture()) {
  const pkg = readPackage(bytes);
  const parsed = parseDocument(pkg);
  return { pkg, parsed, state: EditorState.create({ doc: parsed.doc, schema }) };
}

const bodyOf = (xml: string) => xml.slice(xml.indexOf('<w:body>') + 8, xml.indexOf('<w:sectPr')).replace(/>\s+</g, '><').trim();

describe('docx editing', () => {
  it('writes an untouched document back block for block', () => {
    const { pkg, parsed, state } = load();
    expect(pkg.unsupported).toEqual([]);
    const out = serializeDocument(parsed, state.doc);
    expect(bodyOf(out)).toBe(bodyOf(pkg.documentXml));
    expect(out.slice(out.indexOf('<w:sectPr'))).toBe(pkg.documentXml.slice(pkg.documentXml.indexOf('<w:sectPr')));
  });

  it('regenerates only the edited paragraph and keeps its properties', () => {
    const { pkg, parsed, state } = load();
    // End of the first paragraph ("Пример документа Word").
    const end = state.doc.firstChild!.nodeSize - 1;
    const tr = state.tr.setSelection(TextSelection.create(state.doc, end)).insertText(' — правка');
    const out = serializeDocument(parsed, tr.doc);
    const first = /<w:p>.*?<\/w:p>/.exec(bodyOf(out))![0];
    expect(first).toContain('<w:jc w:val="center"/>');
    expect(first).toContain('<w:rPr><w:b/><w:sz w:val="40"/></w:rPr>');
    expect(first).toContain('Пример документа Word — правка');
    // Everything after the first paragraph is byte-identical to the original.
    const rest = (xml: string) => xml.slice(xml.indexOf('</w:p>') + 6);
    expect(rest(bodyOf(out))).toBe(rest(bodyOf(pkg.documentXml)));
    // Links stay links with their relationship.
    expect(out).toContain('<w:hyperlink r:id="rLink"><w:r><w:t>ссылкой</w:t></w:r></w:hyperlink>');
  });

  it('adds images with media, relationship, content type and namespaces', () => {
    const { pkg, parsed, state } = load();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const rid = addImage(pkg, png, 'image/png');
    const image = schema.nodes.image!.create({ rid, cx: 952500, cy: 476250, src: pkg.images.get(rid) });
    const tr = state.tr.insert(1, image);
    const bytes = writePackage(pkg, serializeDocument(parsed, tr.doc));
    const files = unzipSync(bytes);
    expect(files['word/media/image2.png'] ?? files['word/media/image1.png']).toBeDefined();
    expect(strFromU8(files['word/_rels/document.xml.rels']!)).toContain(`Id="${rid}"`);
    expect(strFromU8(files['[Content_Types].xml']!)).toMatch(/Extension="png"/i);
    const doc = strFromU8(files['word/document.xml']!);
    expect(doc).toContain(`r:embed="${rid}"`);
    expect(doc).toContain('<wp:extent cx="952500" cy="476250"/>');
    // The original embedded image is untouched.
    expect(files['word/media/image1.png']).toEqual(unzipSync(fixture())['word/media/image1.png']);
  });

  it('adds columns to tables and keeps the grid consistent', () => {
    const { parsed, state } = load();
    let tablePos = -1;
    state.doc.forEach((node, offset) => { if (node.type.name === 'table' && tablePos < 0) tablePos = offset; });
    // Cursor into the first cell.
    const inCell = TextSelection.create(state.doc, tablePos + 4);
    let next = state.apply(state.tr.setSelection(inCell));
    addColumnAfter(next, (tr) => { next = next.apply(tr); });
    const out = serializeDocument(parsed, next.doc);
    const tbl = /<w:tbl>.*?<\/w:tbl>/.exec(out)![0];
    expect(tbl.match(/<w:gridCol /g)).toHaveLength(3);
    expect(tbl).toContain('<w:tblBorders>');
    expect(tbl.match(/<w:tc>/g)).toHaveLength(6);
  });

  it('creates list definitions when the document has none', () => {
    const { pkg } = load();
    const numId = ensureList(pkg, 'bullet');
    expect(pkg.lists.get(numId)).toBe('bullet');
    expect(strFromU8(pkg.files['word/numbering.xml']!)).toContain('<w:numFmt w:val="bullet"/>');
    expect(strFromU8(pkg.files['word/_rels/document.xml.rels']!)).toContain('numbering.xml');
    expect(strFromU8(pkg.files['[Content_Types].xml']!)).toContain('/word/numbering.xml');
    expect(ensureList(pkg, 'bullet')).toBe(numId);
  });

  it('reports tracked changes and comments as content a save would lose', () => {
    const files = unzipSync(fixture());
    const xml = strFromU8(files['word/document.xml']!).replace('<w:r><w:t>.</w:t></w:r>', '<w:ins w:id="1" w:author="A"><w:r><w:t>.</w:t></w:r></w:ins>');
    files['word/document.xml'] = strToU8(xml);
    files['word/comments.xml'] = strToU8('<w:comments/>');
    expect(readPackage(zipSync(files)).unsupported.sort()).toEqual(['comments', 'tracked']);
  });
});
