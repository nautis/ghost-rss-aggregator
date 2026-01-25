/**
 * Sanitization utilities
 */

/**
 * Sanitize a filename for safe use in HTTP headers and file systems
 * @param {string} filename
 * @returns {string}
 */
export function sanitizeFilename(filename) {
  if (!filename || typeof filename !== 'string') {
    return 'file';
  }

  // Remove path traversal attempts
  let safe = filename.replace(/\.\./g, '');

  // Remove characters that could break HTTP headers or file systems
  // Keep only alphanumeric, dash, underscore, dot
  safe = safe.replace(/[^a-zA-Z0-9._-]/g, '_');

  // Remove leading/trailing dots and spaces
  safe = safe.replace(/^[.\s]+|[.\s]+$/g, '');

  // Ensure it's not empty
  if (!safe || safe === '_') {
    safe = 'file';
  }

  // Limit length
  if (safe.length > 100) {
    const ext = safe.match(/\.[a-zA-Z0-9]+$/)?.[0] || '';
    safe = safe.substring(0, 100 - ext.length) + ext;
  }

  return safe;
}

/**
 * Escape HTML entities to prevent XSS
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  const escapeMap = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
    '`': '&#x60;',
  };

  return text.replace(/[&<>"'`/]/g, char => escapeMap[char]);
}

/**
 * Strip HTML tags more thoroughly than regex
 * @param {string} html
 * @returns {string}
 */
export function stripHtml(html) {
  if (!html || typeof html !== 'string') {
    return '';
  }

  // Remove script/style tags and their content
  let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove all remaining tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Decode common entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&amp;/g, '&');
  text = text.replace(/&lt;/g, '<');
  text = text.replace(/&gt;/g, '>');
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n));
  text = text.replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)));

  // Normalize whitespace
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

export default { sanitizeFilename, escapeHtml, stripHtml };
