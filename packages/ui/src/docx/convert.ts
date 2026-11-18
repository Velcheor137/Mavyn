import { Schema, type Mark, type MarkSpec, type Node as PMNode, type NodeSpec } from 'prosemirror-model';
import { tableNodes } from 'prosemirror-tables';
import { escAttr, escText, kids, parseFragment, parseXml, serializeElement } from '../xml.ts';
import { W, type DocxPackage } from './package.ts';

/**
 * word/document.xml ⇄ ProseMirror. Every block parsed from the file remembers its original XML; a
 * block the user did not touch keeps its identity in ProseMirror and is written back byte for byte.
 * Edited paragraphs are regenerated from the model plus their original properties (unknown run and
 * paragraph properties are carried along as raw XML). Things the editor does not model (fields,
 * bookmarks, equations, content controls, shapes) are atoms that keep their XML.
 */

const NAMESPACES: Record<string, string> = {
  w: W,
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

const tables = tableNodes({
  tableGroup: 'block',
  cellContent: 'block+',
  cellAttributes: { tcPr: { default: '' } },
});

const HIGHLIGHT: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#00008b', darkCyan: '#008b8b',
  darkGreen: '#006400', darkMagenta: '#8b008b', darkRed: '#8b0000', darkYellow: '#808000', darkGray: '#a9a9a9', lightGray: '#d3d3d3', black: '#000000',
};
export const HIGHLIGHT_NAMES = Object.keys(HIGHLIGHT);

const nodes: Record<string, NodeSpec> = {
  doc: { content: 'block+' },
  paragraph: {
    group: 'block',
    content: 'inline*',
    attrs: { pPr: { default: '' }, style: { default: null }, align: { default: null }, numId: { default: null }, ilvl: { default: 0 }, listKind: { default: null } },
    parseDOM: [{ tag: 'p' }, { tag: 'h1' }, { tag: 'h2' }, { tag: 'h3' }, { tag: 'h4' }, { tag: 'h5' }, { tag: 'h6' }, { tag: 'li' }],
    toDOM: (node) => [
      'p',
      {
        class: 'docx-p',
        ...(node.attrs.style ? { 'data-style': node.attrs.style } : {}),
        ...(node.attrs.listKind ? { 'data-list': node.attrs.listKind, 'data-level': String(node.attrs.ilvl) } : {}),
        ...(node.attrs.align ? { style: `text-align:${alignCss(node.attrs.align as string)}` } : {}),
      },
      0,
    ],
  },
  opaque_block: {
    group: 'block',
    atom: true,
    selectable: true,
    attrs: { xml: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['div', { class: `docx-opaque docx-opaque-block${node.attrs.label ? '' : ' docx-hidden'}`, contenteditable: 'false' }, node.attrs.label as string],
  },
  table: { ...tables.table, attrs: { tblPr: { default: '' }, grid: { default: null } } },
  table_row: { ...tables.table_row, attrs: { trPr: { default: '' } } },
  table_cell: tables.table_cell,
  table_header: tables.table_header,
  text: { group: 'inline' },
  tab: { group: 'inline', inline: true, atom: true, attrs: { rpr: { default: '' } }, toDOM: () => ['span', { class: 'docx-tab' }, '\t'] },
  hard_break: { group: 'inline', inline: true, selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
  image: {
    group: 'inline',
    inline: true,
    atom: true,
    draggable: true,
    attrs: { rid: { default: '' }, cx: { default: 914400 }, cy: { default: 914400 }, xml: { default: '' }, rpr: { default: '' }, src: { default: '' } },
    toDOM: (node) =>
      node.attrs.src
        ? ['img', { class: 'docx-image', src: node.attrs.src as string, alt: '', style: `width:${emuToPx(node.attrs.cx as number)}px;height:${emuToPx(node.attrs.cy as number)}px` }]
        : ['span', { class: 'docx-opaque', contenteditable: 'false', style: `width:${emuToPx(node.attrs.cx as number)}px;height:${emuToPx(node.attrs.cy as number)}px` }, '🖼'],
  },
  opaque: {
    group: 'inline',
    inline: true,
    atom: true,
    attrs: { xml: { default: '' }, label: { default: '' } },
    toDOM: (node) => ['span', { class: `docx-opaque${node.attrs.label ? '' : ' docx-hidden'}`, contenteditable: 'false' }, node.attrs.label as string],
  },
};

const marks: Record<string, MarkSpec> = {
  link: { attrs: { xml: { default: '' } }, inclusive: false, toDOM: () => ['span', { class: 'docx-link' }, 0] },
  bold: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
  italic: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
  underline: { attrs: { val: { default: 'single' } }, parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
  strike: { parseDOM: [{ tag: 's' }, { tag: 'del' }], toDOM: () => ['s', 0] },
  color: { attrs: { value: {} }, toDOM: (m) => ['span', { style: `color:#${m.attrs.value as string}` }, 0] },
  highlight: { attrs: { value: {} }, toDOM: (m) => ['span', { style: `background:${HIGHLIGHT[m.attrs.value as string] ?? 'transparent'}` }, 0] },
  size: { attrs: { half: {} }, toDOM: (m) => ['span', { style: `font-size:${(m.attrs.half as number) / 2}pt` }, 0] },
  font: { attrs: { name: {}, xml: { default: '' } }, toDOM: (m) => ['span', { style: `font-family:"${m.attrs.name as string}",var(--font-sans)` }, 0] },
  /** Run properties the editor does not model, as raw XML (kept on edit). */
  rpr: { attrs: { xml: { default: '' } }, toDOM: () => ['span', 0] },
};

export const schema = new Schema({ nodes, marks });

function alignCss(val: string): string {
  return val === 'both' || val === 'distribute' ? 'justify' : val === 'center' ? 'center' : val === 'right' || val === 'end' ? 'right' : 'left';
}

const EMU_PER_PX = 9525;
export const emuToPx = (emu: number) => Math.max(1, Math.round(emu / EMU_PER_PX));
export const pxToEmu = (px: number) => Math.round(px * EMU_PER_PX);

/** Original XML of blocks parsed from the file. Survives as long as ProseMirror keeps the node. */
const originals = new WeakMap<PMNode, string>();

function wAttr(el: Element | undefined, name: string): string | null {
  return el ? el.getAttributeNS(W, name) ?? el.getAttribute(`w:${name}`) : null;
}

const SIMPLE_RUN_CHILDREN = new Set(['w:rPr', 'w:t', 'w:tab', 'w:br', 'w:cr', 'w:lastRenderedPageBreak', 'w:drawing']);
const HIDDEN = new Set(['w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr', 'w:permStart', 'w:permEnd']);

function labelOf(el: Element): string {
  if (HIDDEN.has(el.tagName)) return '';
  if (el.tagName === 'm:oMath' || el.tagName === 'm:oMathPara') return '∑';
  if (/fldChar|instrText|fldSimple/.test(serializeElement(el).slice(0, 200))) return '{…}';
  return '◆';
}

function isInlinePicture(drawing: Element): boolean {
  return drawing.getElementsByTagName('wp:inline').length === 1 && drawing.getElementsByTagName('a:blip').length === 1;
}

/** Marks of a run's `w:rPr`; what the editor does not model goes into one `rpr` mark. */
function runMarks(rPr: Element | undefined): Mark[] {
  if (!rPr) return [];
  const out: Mark[] = [];
  const rest: string[] = [];
  for (const el of kids(rPr)) {
    const val = wAttr(el, 'val');
    const off = val === '0' || val === 'false' || val === 'none';
    switch (el.tagName) {
      case 'w:b':
        if (!off) out.push(schema.marks.bold!.create());
        else rest.push(serializeElement(el));
        break;
      case 'w:i':
        if (!off) out.push(schema.marks.italic!.create());
        else rest.push(serializeElement(el));
        break;
      case 'w:u':
        if (!off) out.push(schema.marks.underline!.create({ val: val ?? 'single' }));
        else rest.push(serializeElement(el));
        break;
      case 'w:strike':
        if (!off) out.push(schema.marks.strike!.create());
        else rest.push(serializeElement(el));
        break;
      case 'w:color':
        if (val && /^[0-9A-Fa-f]{6}$/.test(val) && !el.hasAttribute('w:themeColor')) out.push(schema.marks.color!.create({ value: val.toUpperCase() }));
        else rest.push(serializeElement(el));
        break;
      case 'w:highlight':
        if (val && HIGHLIGHT[val]) out.push(schema.marks.highlight!.create({ value: val }));
        else rest.push(serializeElement(el));
        break;
      case 'w:sz':
        if (val && /^\d+$/.test(val)) out.push(schema.marks.size!.create({ half: Number(val) }));
        else rest.push(serializeElement(el));
        break;
      case 'w:rFonts': {
        const name = wAttr(el, 'ascii') ?? wAttr(el, 'hAnsi');
        if (name) out.push(schema.marks.font!.create({ name, xml: serializeElement(el) }));
        else rest.push(serializeElement(el));
        break;
      }
      default:
        rest.push(serializeElement(el));
    }
  }
  if (rest.length) out.push(schema.marks.rpr!.create({ xml: rest.join('') }));
  return out;
}

function parseRun(run: Element, linkMarks: Mark[], pkg: DocxPackage): PMNode[] {
  const children = kids(run);
  const simple = children.every((c) => SIMPLE_RUN_CHILDREN.has(c.tagName) && (c.tagName !== 'w:drawing' || isInlinePicture(c)) && (c.tagName !== 'w:br' || !wAttr(c, 'type') || wAttr(c, 'type') === 'textWrapping'));
  if (!simple) return [schema.nodes.opaque!.create({ xml: serializeElement(run), label: labelOf(children.find((c) => c.tagName !== 'w:rPr') ?? run) })];
  const rPr = kids(run, 'w:rPr')[0];
  const marksOf = [...linkMarks, ...runMarks(rPr)];
  const out: PMNode[] = [];
  for (const el of children) {
    if (el.tagName === 'w:t') {
      const text = el.textContent ?? '';
      if (text) out.push(schema.text(text, marksOf));
    } else if (el.tagName === 'w:tab') out.push(schema.nodes.tab!.create({}, null, marksOf));
    else if (el.tagName === 'w:br' || el.tagName === 'w:cr') out.push(schema.nodes.hard_break!.create({}, null, marksOf));
    else if (el.tagName === 'w:drawing') {
      const blip = el.getElementsByTagName('a:blip')[0]!;
      const rid = blip.getAttributeNS(NAMESPACES.r!, 'embed') ?? blip.getAttribute('r:embed') ?? '';
      const extent = el.getElementsByTagName('wp:extent')[0];
      out.push(
        schema.nodes.image!.create({
          rid,
          cx: Number(extent?.getAttribute('cx') ?? 914400),
          cy: Number(extent?.getAttribute('cy') ?? 914400),
          xml: serializeElement(el),
          rpr: rPr ? serializeElement(rPr) : '',
          src: pkg.images.get(rid) ?? '',
        }, null, linkMarks),
      );
    }
  }
  return out;
}

function parseParagraph(p: Element, pkg: DocxPackage): PMNode {
  const pPr = kids(p, 'w:pPr')[0];
  const numPr = pPr ? kids(pPr, 'w:numPr')[0] : undefined;
  const numId = numPr ? wAttr(kids(numPr, 'w:numId')[0], 'val') : null;
  const ilvl = numPr ? Number(wAttr(kids(numPr, 'w:ilvl')[0], 'val') ?? 0) : 0;
  const attrs = {
    pPr: pPr ? serializeElement(pPr) : '',
    style: pPr ? wAttr(kids(pPr, 'w:pStyle')[0], 'val') : null,
    align: pPr ? wAttr(kids(pPr, 'w:jc')[0], 'val') : null,
    numId: numId && numId !== '0' ? numId : null,
    ilvl,
    listKind: numId ? pkg.lists.get(numId) ?? null : null,
  };
  const inline: PMNode[] = [];
  for (const el of kids(p)) {
    if (el.tagName === 'w:pPr') continue;
    if (el.tagName === 'w:r') inline.push(...parseRun(el, [], pkg));
    else if (el.tagName === 'w:hyperlink') {
      const attrsXml = [...el.attributes].filter((a) => !a.name.startsWith('xmlns')).map((a) => `${a.name}="${escAttr(a.value)}"`).join(' ');
      const link = schema.marks.link!.create({ xml: attrsXml });
      for (const inner of kids(el)) {
        if (inner.tagName === 'w:r') inline.push(...parseRun(inner, [link], pkg));
        else inline.push(schema.nodes.opaque!.create({ xml: serializeElement(inner), label: labelOf(inner) }, null, [link]));
      }
    } else inline.push(schema.nodes.opaque!.create({ xml: serializeElement(el), label: labelOf(el) }));
  }
  const node = schema.nodes.paragraph!.create(attrs, inline);
  originals.set(node, serializeElement(p));
  return node;
}

function parseTable(tbl: Element, pkg: DocxPackage): PMNode {
  const tblPr = kids(tbl, 'w:tblPr')[0];
  const grid = kids(kids(tbl, 'w:tblGrid')[0] ?? tbl, 'w:gridCol').map((g) => Number(wAttr(g, 'w') ?? 0));
  const rows: PMNode[] = [];
  for (const tr of kids(tbl, 'w:tr')) {
    const trPr = kids(tr).filter((c) => c.tagName === 'w:trPr' || c.tagName === 'w:tblPrEx').map(serializeElement).join('');
    const cells: PMNode[] = [];
    let col = 0;
    for (const tc of kids(tr, 'w:tc')) {
      const tcPr = kids(tc, 'w:tcPr')[0];
      const colspan = Number(wAttr(tcPr ? kids(tcPr, 'w:gridSpan')[0] : undefined, 'val') ?? 1) || 1;
      const widths = grid.slice(col, col + colspan).map((tw) => Math.round((tw / 20) * (4 / 3)));
      col += colspan;
      let content = parseBlocks(tc, pkg, ['w:tcPr']);
      if (!content.length) content = [schema.nodes.paragraph!.create()];
      cells.push(schema.nodes.table_cell!.create({ colspan, rowspan: 1, colwidth: widths.length === colspan && widths.every((w) => w > 0) ? widths : null, tcPr: tcPr ? serializeElement(tcPr) : '' }, content));
    }
    if (cells.length) rows.push(schema.nodes.table_row!.create({ trPr }, cells));
  }
  const node = schema.nodes.table!.create({ tblPr: tblPr ? serializeElement(tblPr) : '', grid }, rows);
  originals.set(node, serializeElement(tbl));
  return node;
}

function parseBlocks(parent: Element, pkg: DocxPackage, skip: string[] = []): PMNode[] {
  const out: PMNode[] = [];
  for (const el of kids(parent)) {
    if (skip.includes(el.tagName)) continue;
    if (el.tagName === 'w:p') out.push(parseParagraph(el, pkg));
    else if (el.tagName === 'w:tbl' && kids(el, 'w:tr').length) out.push(parseTable(el, pkg));
    else {
      const node = schema.nodes.opaque_block!.create({ xml: serializeElement(el), label: labelOf(el) });
      originals.set(node, serializeElement(el));
      out.push(node);
    }
  }
  return out;
}

export interface ParsedDocument {
  doc: PMNode;
  /** document.xml up to and including `<w:body>`. */
  head: string;
  /** The final `w:sectPr` and everything after the body content. */
  tail: string;
}

export function parseDocument(pkg: DocxPackage): ParsedDocument {
  const xml = pkg.documentXml;
  const dom = parseXml(xml);
  const body = dom.getElementsByTagNameNS(W, 'body')[0];
  if (!body) throw new Error('document without body');
  const sectPr = kids(body, 'w:sectPr').at(-1);
  const blocks = parseBlocks(body, pkg, ['w:sectPr']);
  const bodyOpen = /<w:body\b[^>]*>/.exec(xml)!;
  const head = xml.slice(0, bodyOpen.index + bodyOpen[0].length);
  const tail = `${sectPr ? serializeElement(sectPr) : ''}${xml.slice(xml.lastIndexOf('</w:body>'))}`;
  return { doc: schema.nodes.doc!.create(null, blocks.length ? blocks : [schema.nodes.paragraph!.create()]), head, tail };
}

// ---------- serialization ----------

const RPR_ORDER = ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'];
const PPR_ORDER = ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];

/** Orders `w:` children by the schema sequence (Word rejects some out-of-order properties). */
function ordered(parts: string[], order: string[]): string {
  const rank = (xml: string) => {
    const i = order.indexOf(/^<w:(\w+)/.exec(xml)?.[1] ?? '');
    return i < 0 ? order.length : i;
  };
  return [...parts].sort((a, b) => rank(a) - rank(b)).join('');
}

function splitChildren(xml: string): string[] {
  return xml ? parseFragment(xml, NAMESPACES).map(serializeElement) : [];
}

function rPrOf(markList: readonly Mark[]): string {
  const parts: string[] = [];
  for (const m of markList) {
    switch (m.type.name) {
      case 'bold': parts.push('<w:b/>'); break;
      case 'italic': parts.push('<w:i/>'); break;
      case 'underline': parts.push(`<w:u w:val="${escAttr(m.attrs.val as string)}"/>`); break;
      case 'strike': parts.push('<w:strike/>'); break;
      case 'color': parts.push(`<w:color w:val="${escAttr(m.attrs.value as string)}"/>`); break;
      case 'highlight': parts.push(`<w:highlight w:val="${escAttr(m.attrs.value as string)}"/>`); break;
      case 'size': parts.push(`<w:sz w:val="${m.attrs.half as number}"/>`); break;
      case 'font': {
        const name = m.attrs.name as string;
        const original = m.attrs.xml as string;
        parts.push(original && new RegExp(`w:ascii="${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(original) ? original : `<w:rFonts w:ascii="${escAttr(name)}" w:hAnsi="${escAttr(name)}" w:cs="${escAttr(name)}"/>`);
        break;
      }
      case 'rpr': parts.push(...splitChildren(m.attrs.xml as string)); break;
      default:
    }
  }
  return parts.length ? `<w:rPr>${ordered(parts, RPR_ORDER)}</w:rPr>` : '';
}

/** `w:drawing` of an image: the original (resized if needed) or a new inline picture. */
let drawingId = 1000;
function drawingXml(node: PMNode): string {
  const { xml, cx, cy, rid } = node.attrs as { xml: string; cx: number; cy: number; rid: string };
  if (xml) {
    return xml
      .replace(/(<wp:extent\b[^>]*\bcx=")\d+("[^>]*\bcy=")\d+/, `$1${cx}$2${cy}`)
      .replace(/(<a:ext\b[^>]*\bcx=")\d+("[^>]*\bcy=")\d+/, `$1${cx}$2${cy}`);
  }
  const id = ++drawingId;
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Picture ${id}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${escAttr(rid)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function inlineXml(node: PMNode): string {
  const own = node.marks.filter((m) => m.type.name !== 'link');
  switch (node.type.name) {
    case 'text': return `<w:r>${rPrOf(own)}<w:t xml:space="preserve">${escText(node.text ?? '')}</w:t></w:r>`;
    case 'tab': return `<w:r>${rPrOf(own)}<w:tab/></w:r>`;
    case 'hard_break': return `<w:r>${rPrOf(own)}<w:br/></w:r>`;
    case 'image': return `<w:r>${node.attrs.rpr as string}${drawingXml(node)}</w:r>`;
    case 'opaque': return node.attrs.xml as string;
    default: return '';
  }
}

function paragraphProps(node: PMNode): string {
  const { pPr, style, align, numId, ilvl } = node.attrs as { pPr: string; style: string | null; align: string | null; numId: string | null; ilvl: number };
  const inner = pPr ? splitChildren(pPr.replace(/^<w:pPr\b[^>]*>|<\/w:pPr>$/g, '').replace(/^<w:pPr\b[^>]*\/>$/, '')) : [];
  const parts = inner.filter((x) => !/^<w:(pStyle|jc|numPr)\b/.test(x));
  if (style) parts.push(`<w:pStyle w:val="${escAttr(style)}"/>`);
  if (numId) parts.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${escAttr(numId)}"/></w:numPr>`);
  if (align) parts.push(`<w:jc w:val="${escAttr(align)}"/>`);
  return parts.length ? `<w:pPr>${ordered(parts, PPR_ORDER)}</w:pPr>` : '';
}

function paragraphXml(node: PMNode): string {
  let out = `<w:p>${paragraphProps(node)}`;
  let link: Mark | null = null;
  let group = '';
  const flush = () => {
    if (link) out += `<w:hyperlink ${link.attrs.xml as string}>${group}</w:hyperlink>`;
    else out += group;
    group = '';
  };
  node.forEach((child) => {
    const childLink = child.marks.find((m) => m.type.name === 'link') ?? null;
    if (childLink !== link && !(childLink && link && childLink.eq(link))) {
      flush();
      link = childLink;
    }
    group += inlineXml(child);
  });
  flush();
  return `${out}</w:p>`;
}

/** Cell properties with the current column span. */
function cellProps(node: PMNode): string {
  const { tcPr, colspan } = node.attrs as { tcPr: string; colspan: number };
  const inner = tcPr ? splitChildren(tcPr.replace(/^<w:tcPr\b[^>]*>|<\/w:tcPr>$/g, '').replace(/^<w:tcPr\b[^>]*\/>$/, '')) : [];
  const parts = inner.filter((x) => !/^<w:gridSpan\b/.test(x));
  if (colspan > 1) {
    // gridSpan follows tcW (cell width) in the schema sequence.
    const at = parts.findIndex((x) => !/^<w:(cnfStyle|tcW)\b/.test(x));
    parts.splice(at < 0 ? parts.length : at, 0, `<w:gridSpan w:val="${colspan}"/>`);
  }
  return parts.length ? `<w:tcPr>${parts.join('')}</w:tcPr>` : '';
}

function tableXml(node: PMNode): string {
  const { tblPr, grid } = node.attrs as { tblPr: string; grid: number[] | null };
  let columns = 0;
  node.forEach((row) => {
    let n = 0;
    row.forEach((cell) => (n += cell.attrs.colspan as number));
    columns = Math.max(columns, n);
  });
  const known = grid ?? [];
  const average = known.length ? Math.round(known.reduce((a, b) => a + b, 0) / known.length) : 2000;
  const cols = Array.from({ length: columns }, (_, i) => known[i] || average);
  let out = `<w:tbl>${tblPr || '<w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>'}<w:tblGrid>${cols.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  node.forEach((row) => {
    out += `<w:tr>${row.attrs.trPr as string}`;
    row.forEach((cell) => {
      let blocks = '';
      let lastIsParagraph = false;
      cell.forEach((block) => {
        blocks += blockXml(block);
        lastIsParagraph = block.type.name === 'paragraph';
      });
      // A cell must end with a paragraph.
      out += `<w:tc>${cellProps(cell)}${blocks}${lastIsParagraph ? '' : '<w:p/>'}</w:tc>`;
    });
    out += '</w:tr>';
  });
  return `${out}</w:tbl>`;
}

function blockXml(node: PMNode): string {
  const original = originals.get(node);
  if (original !== undefined) return original;
  if (node.type.name === 'paragraph') return paragraphXml(node);
  if (node.type.name === 'table') return tableXml(node);
  if (node.type.name === 'opaque_block') return node.attrs.xml as string;
  return '';
}

/** The new document.xml for `doc`. Namespaces new pictures need are declared on the root. */
export function serializeDocument(parsed: ParsedDocument, doc: PMNode): string {
  let body = '';
  doc.forEach((block) => (body += blockXml(block)));
  let head = parsed.head;
  for (const [prefix, uri] of Object.entries(NAMESPACES)) {
    if (!new RegExp(`xmlns:${prefix}=`).test(head)) head = head.replace(/<w:document\b/, `<w:document xmlns:${prefix}="${uri}"`);
  }
  return head + body + parsed.tail;
}
