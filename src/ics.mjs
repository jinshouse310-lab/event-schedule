const icsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const icsDay = (iso) => new Date(iso).toISOString().slice(0, 10).replace(/-/g, '');
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
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
export function buildIcs(events, lang = 'ja') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Biogas Division//Event Schedule//JA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Biogas Division Events'];
  const sorted = events.filter((e) => e.status !== 'cancelled').sort((a, b) => a.start_at.localeCompare(b.start_at));
  for (const e of sorted) {
    const typeLabel = lang === 'en' ? e.type_label_en : e.type_label_ja;
    const title = lang === 'en' && e.title_en ? e.title_en : e.title;
    const owner = lang === 'en' && e.owner_name_en ? e.owner_name_en : e.owner_name;
    lines.push('BEGIN:VEVENT', `UID:event-${e.id}@biogas-schedule`, `DTSTAMP:${icsDate(e.updated_at || e.created_at)}`);
    if (e.all_day) {
      const end = new Date(e.end_at || e.start_at);
      end.setUTCDate(end.getUTCDate() + 1);
      lines.push(`DTSTART;VALUE=DATE:${icsDay(e.start_at)}`, `DTEND;VALUE=DATE:${icsDay(end.toISOString())}`);
    } else {
      lines.push(`DTSTART:${icsDate(e.start_at)}`, `DTEND:${icsDate(e.end_at || new Date(Date.parse(e.start_at) + 3600e3).toISOString())}`);
    }
    lines.push(fold(`SUMMARY:${esc(`[${typeLabel}] ${title}`)}`));
    if (e.location) lines.push(fold(`LOCATION:${esc(e.location)}`));
    const desc = [owner ? (lang === 'en' ? `Owner: ${owner}` : `主担当: ${owner}`) : '', e.description].filter(Boolean).join('\n');
    if (desc) lines.push(fold(`DESCRIPTION:${esc(desc)}`));
    lines.push(`STATUS:${e.status === 'confirmed' || e.status === 'done' ? 'CONFIRMED' : 'TENTATIVE'}`, 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
