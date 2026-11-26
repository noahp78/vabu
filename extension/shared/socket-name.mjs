export const defaultSocketNames = Object.freeze({ chrome: 'chrome-default', firefox: 'firefox-default' });
export const socketNameError = 'Socket name must be 1–32 characters: start with a lower-case ASCII letter, use only lower-case letters, digits or hyphens, and end with a letter or digit.';

export function validSocketName(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 32
    && /^[a-z]/.test(name) && !/[^a-z0-9-]/.test(name) && !name.endsWith('-');
}
