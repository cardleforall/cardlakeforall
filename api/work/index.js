const { collection } = require('../_lib/resources');
const { work } = require('../_lib/resource-configs');
// GET list / POST insert into work_items; POST authentication is enforced by collection().
module.exports = collection(work);
