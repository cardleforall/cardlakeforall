const { item } = require('../_lib/resources');
const { talkingPoints } = require('../_lib/resource-configs');
// PATCH full content update / DELETE update talking_points; writes require a resolved tenant via resolveWriterTenant() in item().
module.exports = item(talkingPoints);
