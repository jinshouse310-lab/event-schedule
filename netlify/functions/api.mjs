import { createHandler } from '../../src/app.mjs';

const handler = createHandler({
  passcode: process.env.APP_PASSCODE || '',
  secret: process.env.SESSION_SECRET || 'change-me',
  maxUploadMb: process.env.MAX_UPLOAD_MB || 4,
});

export default async (req) => handler(req);

export const config = {
  path: ['/api/*', '/calendar.ics'],
};
