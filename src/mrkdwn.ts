// Convert standard CommonMark markdown into Slack mrkdwn.
// Slack uses *bold* (single asterisk), _italic_, and <url|text> links.
// Code fences are passed through unchanged.

export function toMrkdwn(text: string): string {
  if (!text) return text;
  const parts = text.split(/(```[\s\S]*?```)/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return convertOutsideCode(part);
    })
    .join('');
}

function convertOutsideCode(text: string): string {
  // Split by inline code (`) and only convert non-code segments
  const inlineParts = text.split(/(`[^`\n]+`)/);
  return inlineParts
    .map((seg, i) => (i % 2 === 1 ? seg : convertInline(seg)))
    .join('');
}

function convertInline(text: string): string {
  let s = text;
  // Bold: **x** → *x*
  s = s.replace(/\*\*([^\n*][^\n]*?)\*\*/g, '*$1*');
  // Headings: # x → *x*
  s = s.replace(/^(#{1,6})\s+(.+)$/gm, '*$2*');
  // Markdown links [text](url) → Slack <url|text>
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, '<$2|$1>');
  return s;
}
