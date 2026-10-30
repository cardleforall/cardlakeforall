const { collection } = require('../_lib/resources');
const { bookmarks } = require('../_lib/resource-configs');
// GET list / POST insert into bookmarks; POST authentication is enforced by collection().
module.exports = collection(bookmarks);
