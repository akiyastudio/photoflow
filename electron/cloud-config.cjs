/**
 * Public CloudBase API configuration.
 *
 * This file is bundled with the desktop app, so values here are NOT secrets.
 * Keep CloudBase SecretId, SecretKey, API keys, and admin tokens on the server.
 */
module.exports = {
  // HTTP cloud function gateway URL, for example:
  // https://your-env-id.ap-shanghai.app.tcloudbase.com
  apiBaseUrl: 'https://app1-d2gzristide4d89c9-1395079986.ap-shanghai.app.tcloudbase.com',

  // A public application identifier used only to reject unrelated traffic.
  // It is not an authentication secret because desktop users can inspect it.
  ingestKey: 'photoflow-desktop-v1',

  updateChannel: 'stable',
};
