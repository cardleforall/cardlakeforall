const { item } = require('../_lib/resources');
const { work } = require('../_lib/resource-configs');
// PATCH / DELETE update work_items; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(work);
