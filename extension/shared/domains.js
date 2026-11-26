export function webUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname.includes('*')) {
    throw new Error('Use a specific HTTP(S) domain without URL credentials');
  }
  return url;
}

export function domainPattern(url) {
  return url.protocol + '//' + url.hostname + '/*';
}

export function hasHostAccess(permissions, url) {
  return permissions.contains({ origins: [domainPattern(url)] });
}
