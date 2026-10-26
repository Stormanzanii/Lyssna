// Kuromoji's dictionary loader joins URL parts with Node's `path`, which the
// browser lacks; URLs only need forward slashes.
module.exports = {
  join: (...parts) => parts.join("/").replace(/\/{2,}/g, "/"),
};
