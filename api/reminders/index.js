const { collection } = require('../_lib/resources');
const { reminders } = require('../_lib/resource-configs');
// GET list / POST insert into reminders; POST authentication is enforced by collection().
module.exports = collection(reminders);
