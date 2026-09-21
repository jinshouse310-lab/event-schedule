'use strict';
const express = require('express');

function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}
function icsDay(iso) {
  return new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
}
function esc(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function fold(line) {
  const out = [];
  let s = line;
  while (Buffer.byteLength(s) > 73) {
    let cut = 73;
    while (Buffer.byteLength(s.slice(0, cut)) > 73) cut--;
    out.push(s.slice(0, cut));
    s = ' ' + s.slice(cut);
  }
  out.push(s);
  return out.join('\r\n');
}

/** iCalendar feed so members can subscribe from Outlook / Google Calendar. */
module.exports = function icsRouter(db) {
  const router = express.Router();
  router.get('/calendar.ics', (req, res) => {
    const lang = req.query.lang === 'en' ? 'en' : 'ja';
    const rows = db
      .prepare(
        `SELECT e.*, t.label_ja, t.label_en, m.name AS owner_name, m.name_en AS owner_name_en
         FROM events e JOIN event_types t ON t.id = e.type_id LEFT JOIN members m ON m.id = e.owner_id
         WHERE e.status != 'cancelled' ORDER BY e.start_at`
      )
      .all();
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Biogas Division//Event Schedule//JA',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:Biogas Division Events',
    ];
    for (const e of rows) {
      const typeLabel = lang === 'en' ? e.label_en : e.label_ja;
      const title = lang === 'en' && e.title_en ? e.title_en : e.title;
      const owner = lang === 'en' && e.owner_name_en ? e.owner_name_en : e.owner_name;
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:event-${e.id}@biogas-schedule`);
      lines.push(`DTSTAMP:${icsDate(e.updated_at || e.created_at)}`);
      if (e.all_day) {
        lines.push(`DTSTART;VALUE=DATE:${icsDay(e.start_at)}`);
        const end = new Date(e.end_at || e.start_at);
        end.setUTCDate(end.getUTCDate() + 1);
        lines.push(`DTEND;VALUE=DATE:${icsDay(end.toISOString())}`);
      } else {
        lines.push(`DTSTART:${icsDate(e.start_at)}`);
        lines.push(`DTEND:${icsDate(e.end_at || new Date(Date.parse(e.start_at) + 3600e3).toISOString())}`);
      }
      lines.push(fold(`SUMMARY:${esc(`[${typeLabel}] ${title}`)}`));
      if (e.location) lines.push(fold(`LOCATION:${esc(e.location)}`));
      const desc = [owner ? (lang === 'en' ? `Owner: ${owner}` : `主担当: ${owner}`) : '', e.description].filter(Boolean).join('\n');
      if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
      lines.push(`STATUS:${e.status === 'confirmed' || e.status === 'done' ? 'CONFIRMED' : 'TENTATIVE'}`);
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="biogas-events.ics"');
    res.send(lines.join('\r\n') + '\r\n');
  });
  return router;
};
