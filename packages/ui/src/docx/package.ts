import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { escAttr, kids, parseXml } from '../xml.ts';

/**
 * The docx zip package: only `word/document.xml` is parsed for editing. Every other part (styles,
 * numbering, headers, footers, theme, settings, fonts) is written back byte for byte, except what an
 * edit has to add (new media, their relationships and content types, list definitions).
 */

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_NUMBERING = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

export interface ParagraphStyle {
  id: string;
  name: string;
  /** 1–9 for headings ("heading 1" or an outline level), otherwise null. */
  heading: number | null;
  css: string;
}

export interface DocxPackage {
  files: Record<string, Uint8Array>;
  documentXml: string;
  rels: Relationship[];
  /** Paragraph styles of styles.xml, for the style picker and the editor's CSS. */
  styles: ParagraphStyle[];
  defaultCss: string;
  /** numId → list kind, from numbering.xml. */
  lists: Map<string, 'bullet' | 'decimal'>;
  /** Page content width in px (page width minus margins), from the last section. */
  pageWidthPx: number;
  /** Object URLs of embedded images by relationship id (revoked with `dispose`). */
  images: Map<string, string>;
  unsupported: string[];
}

const twipsToPx = (twips: number) => Math.round((twips / 20) * (4 / 3));

/** Object URL for image bytes; a data URL where object URLs do not exist (tests). */
function objectUrl(bytes: Uint8Array, mime: string): string {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

function relsOf(xml: string | undefined): Relationship[] {
  if (!xml) return [];
  const doc = parseXml(xml);
  return [...doc.getElementsByTagNameNS(REL_NS, 'Relationship')].map((r) => ({
    id: r.getAttribute('Id') ?? '',
    type: r.getAttribute('Type') ?? '',
    target: r.getAttribute('Target') ?? '',
    external: r.getAttribute('TargetMode') === 'External',
  }));
}

function attrW(el: Element | undefined, name: string): string | null {
  return el?.getAttributeNS(W, name) ?? el?.getAttribute(`w:${name}`) ?? null;
}

function child(el: Element | undefined, name: string): Element | undefined {
  return el ? kids(el, name)[0] : undefined;
}

/** CSS of run/paragraph properties (the subset the editor can show). */
function propsCss(pPr: Element | undefined, rPr: Element | undefined): string[] {
  const css: string[] = [];
  const b = child(rPr, 'w:b');
  if (b && attrW(b, 'val') !== '0' && attrW(b, 'val') !== 'false') css.push('font-weight:600');
  const i = child(rPr, 'w:i');
  if (i && attrW(i, 'val') !== '0' && attrW(i, 'val') !== 'false') css.push('font-style:italic');
  const sz = attrW(child(rPr, 'w:sz'), 'val');
  if (sz) css.push(`font-size:${Number(sz) / 2}pt`);
  const color = attrW(child(rPr, 'w:color'), 'val');
  if (color && /^[0-9A-Fa-f]{6}$/.test(color)) css.push(`color:#${color}`);
  const font = attrW(child(rPr, 'w:rFonts'), 'ascii');
  if (font) css.push(`font-family:"${font.replace(/"/g, '')}",var(--font-sans)`);
  const jc = attrW(child(pPr, 'w:jc'), 'val');
  if (jc) css.push(`text-align:${jc === 'both' || jc === 'distribute' ? 'justify' : jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : 'left'}`);
  const spacing = child(pPr, 'w:spacing');
  const before = attrW(spacing, 'before');
  const after = attrW(spacing, 'after');
  if (before) css.push(`margin-top:${twipsToPx(Number(before))}px`);
  if (after) css.push(`margin-bottom:${twipsToPx(Number(after))}px`);
  return css;
}

function stylesOf(xml: string | undefined): { styles: ParagraphStyle[]; defaultCss: string } {
  if (!xml) return { styles: [], defaultCss: '' };
  const doc = parseXml(xml);
  const defaults = doc.getElementsByTagNameNS(W, 'docDefaults')[0];
  const defaultCss = propsCss(
    child(child(defaults, 'w:pPrDefault'), 'w:pPr'),
    child(child(defaults, 'w:rPrDefault'), 'w:rPr'),
  ).join(';');
  const byId = new Map<string, Element>();
  for (const style of doc.getElementsByTagNameNS(W, 'style')) {
    if (attrW(style, 'type') === 'paragraph') byId.set(attrW(style, 'styleId') ?? '', style);
  }
  const resolve = (id: string, depth = 0): string[] => {
    const style = byId.get(id);
    if (!style || depth > 10) return [];
    const base = attrW(child(style, 'w:basedOn'), 'val');
    return [...(base ? resolve(base, depth + 1) : []), ...propsCss(child(style, 'w:pPr'), child(style, 'w:rPr'))];
  };
  const styles: ParagraphStyle[] = [];
  for (const [id, style] of byId) {
    const name = attrW(child(style, 'w:name'), 'val') ?? id;
    const headingName = /^heading (\d)$/i.exec(name);
    const outline = attrW(child(child(style, 'w:pPr'), 'w:outlineLvl'), 'val');
    const heading = headingName ? Number(headingName[1]) : outline !== null && Number(outline) < 9 ? Number(outline) + 1 : null;
    styles.push({ id, name, heading, css: resolve(id).join(';') });
  }
  return { styles, defaultCss };
}

function listsOf(xml: string | undefined): Map<string, 'bullet' | 'decimal'> {
  const lists = new Map<string, 'bullet' | 'decimal'>();
  if (!xml) return lists;
  const doc = parseXml(xml);
  const abstract = new Map<string, 'bullet' | 'decimal'>();
  for (const a of doc.getElementsByTagNameNS(W, 'abstractNum')) {
    const lvl0 = [...a.getElementsByTagNameNS(W, 'lvl')].find((l) => attrW(l, 'ilvl') === '0');
    const fmt = attrW(child(lvl0, 'w:numFmt'), 'val');
    abstract.set(attrW(a, 'abstractNumId') ?? '', fmt === 'bullet' ? 'bullet' : 'decimal');
  }
  for (const n of doc.getElementsByTagNameNS(W, 'num')) {
    const kind = abstract.get(attrW(child(n, 'w:abstractNumId'), 'val') ?? '');
    if (kind) lists.set(attrW(n, 'numId') ?? '', kind);
  }
  return lists;
}

const MIME_OF: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

/** Reasons a save would lose content (i18n keys `files.reason_*`). */
function unsupportedOf(files: Record<string, Uint8Array>, documentXml: string): string[] {
  const reasons = new Set<string>();
  if (/<w:(ins|del|moveFrom|moveTo|rPrChange|pPrChange|tblPrChange|tcPrChange|trPrChange|sectPrChange)\b/.test(documentXml)) reasons.add('tracked');
  if (/<w:comment(RangeStart|Reference)\b/.test(documentXml) || files['word/comments.xml']) reasons.add('comments');
  if (/<w:altChunk\b/.test(documentXml)) reasons.add('misc');
  if (/<w:object\b/.test(documentXml) || Object.keys(files).some((n) => n.startsWith('word/embeddings/'))) reasons.add('objects');
  if (Object.keys(files).some((n) => /vbaProject\.bin$/.test(n))) reasons.add('macros');
  return [...reasons];
}

export function readPackage(bytes: Uint8Array): DocxPackage {
  const files = unzipSync(bytes);
  const documentXml = strFromU8(files['word/document.xml'] ?? new Uint8Array());
  if (!documentXml) throw new Error('docx without word/document.xml');
  const rels = relsOf(files['word/_rels/document.xml.rels'] ? strFromU8(files['word/_rels/document.xml.rels']) : undefined);
  const { styles, defaultCss } = stylesOf(files['word/styles.xml'] ? strFromU8(files['word/styles.xml']) : undefined);
  const lists = listsOf(files['word/numbering.xml'] ? strFromU8(files['word/numbering.xml']) : undefined);
  const images = new Map<string, string>();
  for (const rel of rels) {
    // External images are never fetched (privacy): they show as placeholders.
    if (rel.type !== REL_IMAGE || rel.external) continue;
    const path = `word/${rel.target.replace(/^\.?\//, '').replace(/^word\//, '')}`;
    const data = files[path];
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    if (data && MIME_OF[ext] && ext !== 'svg') images.set(rel.id, objectUrl(data, MIME_OF[ext]!));
  }
  const pg = /<w:pgSz\b[^>]*w:w="(\d+)"/.exec(documentXml);
  const left = /<w:pgMar\b[^>]*w:left="(\d+)"/.exec(documentXml);
  const right = /<w:pgMar\b[^>]*w:right="(\d+)"/.exec(documentXml);
  const pageWidthPx = pg ? twipsToPx(Number(pg[1]) - Number(left?.[1] ?? 1440) - Number(right?.[1] ?? 1440)) : 624;
  return { files, documentXml, rels, styles, defaultCss, lists, pageWidthPx, images, unsupported: unsupportedOf(files, documentXml) };
}

export function disposePackage(pkg: DocxPackage): void {
  for (const url of pkg.images.values()) if (url.startsWith('blob:')) URL.revokeObjectURL(url);
}

function nextRelId(pkg: DocxPackage): string {
  let n = pkg.rels.length + 1;
  while (pkg.rels.some((r) => r.id === `rId${n}`)) n++;
  return `rId${n}`;
}

function relsXml(rels: Relationship[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${rels
    .map((r) => `<Relationship Id="${escAttr(r.id)}" Type="${escAttr(r.type)}" Target="${escAttr(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`)
    .join('')}</Relationships>`;
}

/** Adds `Default Extension` / `Override` entries to [Content_Types].xml when missing. */
function ensureContentType(pkg: DocxPackage, entry: { extension: string; type: string } | { part: string; type: string }): void {
  const xml = strFromU8(pkg.files['[Content_Types].xml'] ?? strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'));
  const exists = 'extension' in entry ? new RegExp(`Extension="${entry.extension}"`, 'i').test(xml) : xml.includes(`PartName="${entry.part}"`);
  if (exists) return;
  const tag = 'extension' in entry ? `<Default Extension="${entry.extension}" ContentType="${entry.type}"/>` : `<Override PartName="${entry.part}" ContentType="${entry.type}"/>`;
  pkg.files['[Content_Types].xml'] = strToU8(xml.replace('</Types>', `${tag}</Types>`));
}

/** Stores a new image in word/media and returns its relationship id. */
export function addImage(pkg: DocxPackage, bytes: Uint8Array, mime: string): string {
  const ext = Object.entries(MIME_OF).find(([, m]) => m === mime)?.[0] ?? 'png';
  let n = 1;
  while (pkg.files[`word/media/image${n}.${ext}`]) n++;
  const path = `word/media/image${n}.${ext}`;
  pkg.files[path] = bytes;
  const id = nextRelId(pkg);
  pkg.rels.push({ id, type: REL_IMAGE, target: `media/image${n}.${ext}`, external: false });
  pkg.files['word/_rels/document.xml.rels'] = strToU8(relsXml(pkg.rels));
  ensureContentType(pkg, { extension: ext, type: mime });
  pkg.images.set(id, objectUrl(bytes, mime));
  return id;
}

/**
 * A list definition of the given kind: an existing one from numbering.xml, or a new numbering part
 * with a bullet and a decimal list (nine levels each).
 */
export function ensureList(pkg: DocxPackage, kind: 'bullet' | 'decimal'): string {
  for (const [numId, k] of pkg.lists) if (k === kind) return numId;
  const levels = (fmt: 'bullet' | 'decimal') =>
    Array.from({ length: 9 }, (_, i) => {
      const text = fmt === 'bullet' ? ['•', '◦', '▪'][i % 3] : `%${i + 1}.`;
      return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
    }).join('');
  let xml = pkg.files['word/numbering.xml'] ? strFromU8(pkg.files['word/numbering.xml']) : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}"></w:numbering>`;
  const ids = (re: RegExp) => [...xml.matchAll(re)].map((m) => Number(m[1]));
  const abstractId = Math.max(0, ...ids(/w:abstractNumId="(\d+)"/g)) + 1;
  const numId = String(Math.max(0, ...ids(/<w:num\b[^>]*w:numId="(\d+)"/g)) + 1);
  const abstract = `<w:abstractNum w:abstractNumId="${abstractId}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(kind)}</w:abstractNum>`;
  const num = `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`;
  // abstractNum elements must come before num elements.
  xml = /<w:num\b/.test(xml) ? xml.replace(/<w:num\b/, `${abstract}<w:num`) : xml.replace('</w:numbering>', `${abstract}</w:numbering>`);
  xml = xml.replace('</w:numbering>', `${num}</w:numbering>`);
  pkg.files['word/numbering.xml'] = strToU8(xml);
  if (!pkg.rels.some((r) => r.type === REL_NUMBERING)) {
    pkg.rels.push({ id: nextRelId(pkg), type: REL_NUMBERING, target: 'numbering.xml', external: false });
    pkg.files['word/_rels/document.xml.rels'] = strToU8(relsXml(pkg.rels));
    ensureContentType(pkg, { part: '/word/numbering.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml' });
  }
  pkg.lists.set(numId, kind);
  return numId;
}

export function writePackage(pkg: DocxPackage, documentXml: string): Uint8Array {
  const files: Zippable = {};
  for (const [name, data] of Object.entries(pkg.files)) {
    if (name.endsWith('/')) continue;
    files[name] = name === 'word/document.xml' ? strToU8(documentXml) : data;
  }
  return zipSync(files, { level: 6 });
}
