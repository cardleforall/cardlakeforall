const { collection } = require('../_lib/resources');
const { family } = require('../_lib/resource-configs');
// GET list / POST insert into family_updates; POST authentication is enforced by collection().
module.exports = collection(family);
