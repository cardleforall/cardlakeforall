const { item } = require('../_lib/resources');
const { bookmarks } = require('../_lib/resource-configs');
// PATCH / DELETE update bookmarks; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(bookmarks);
