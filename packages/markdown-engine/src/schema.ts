import { defaultSchema, type Options as Schema } from 'rehype-sanitize';

const base = defaultSchema.attributes ?? {};

/**
 * Allow-list for rendered Markdown, derived from GitHub's policy. Everything not listed is dropped:
 * scripts, styles, event handlers, iframes/objects/embeds, forms, SVG, and non-allow-listed URL
 * schemes. Changes here require a test in `sanitize.test.ts`.
 */
export const sanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...base,
    '*': [...(base['*'] ?? []), 'dataLine'],
    code: [['className', /^language-./, 'math-inline', 'math-display']],
    li: [...(base.li ?? []), 'dataTaskOffset'],
    div: [
      ...(base.div ?? []),
      ['className', 'callout', /^callout-[a-z]+$/],
      'dataCallout',
      'dataCalloutFold',
    ],
    p: [['className', 'callout-title'], 'dataCalloutTitle'],
    img: [...(base.img ?? []), 'loading'],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    // `data:` is narrowed further to raster images by `rehypeImagePolicy`.
    src: ['http', 'https', 'data'],
  },
};
