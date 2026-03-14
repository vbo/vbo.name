/**
 * Hexo filter: replace __ROOT__ placeholder with config.root in rendered HTML.
 * Use in markdown: [text](__ROOT__path/to/page/) for portable internal links.
 */
function replaceRoot(obj, root) {
  if (obj && typeof obj === 'string') {
    return obj.replace(/__ROOT__/g, root);
  }
  return obj;
}

hexo.extend.filter.register('after_post_render', function (data) {
  const root = hexo.config.root || '/';
  if (data.content) data.content = replaceRoot(data.content, root);
  if (data.excerpt) data.excerpt = replaceRoot(data.excerpt, root);
  return data;
});
