/** Small XML helpers for the office formats (ods, docx), working on the browser's DOMParser. */

export function escAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Element → XML keeping the original prefixes (declared on the document root). XMLSerializer would
 * invent new prefixes and namespace declarations for a detached subtree.
 */
export function serializeElement(el: Element): string {
  let out = `<${el.tagName}`;
  for (const a of el.attributes) if (!a.name.startsWith('xmlns')) out += ` ${a.name}="${escAttr(a.value)}"`;
  if (!el.childNodes.length) return `${out}/>`;
  out += '>';
  for (const node of el.childNodes) {
    if (node.nodeType === 1) out += serializeElement(node as Element);
    else if (node.nodeType === 3 || node.nodeType === 4) out += escText(node.nodeValue ?? '');
  }
  return `${out}</${el.tagName}>`;
}

export function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('invalid xml');
  return doc;
}

/** Element children with the given qualified name (`w:p`), in order. */
export function kids(el: Element, name?: string): Element[] {
  return [...el.children].filter((c) => !name || c.tagName === name);
}

/** Parses an XML fragment of elements using the namespaces of `root` (prefixes must be declared there). */
export function parseFragment(xml: string, namespaces: Record<string, string>): Element[] {
  const decls = Object.entries(namespaces).map(([p, uri]) => ` xmlns:${p}="${uri}"`).join('');
  const doc = parseXml(`<frag${decls}>${xml}</frag>`);
  return [...doc.documentElement.children];
}
