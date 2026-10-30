const { item } = require('../_lib/resources');
const { reminders } = require('../_lib/resource-configs');
// PATCH / DELETE update reminders; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(reminders);
