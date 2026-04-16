import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { TEST_PROFILE } from '../core/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../../fixtures/resume.pdf');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const doc = new PDFDocument({ margin: 50 });
const stream = fs.createWriteStream(outPath);
doc.pipe(stream);

doc.fontSize(20).text(TEST_PROFILE.fullName, { align: 'left' });
doc
  .fontSize(10)
  .fillColor('#444')
  .text(`${TEST_PROFILE.email} · ${TEST_PROFILE.phone} · ${TEST_PROFILE.location}`);
doc.text(`${TEST_PROFILE.linkedin} · ${TEST_PROFILE.github} · ${TEST_PROFILE.website}`);
doc.moveDown(0.8);

doc.fontSize(12).fillColor('#000').text('Summary', { underline: true });
doc.fontSize(10).text(TEST_PROFILE.summary);
doc.moveDown(0.8);

doc.fontSize(12).text('Experience', { underline: true });
for (const e of TEST_PROFILE.experience) {
  doc.moveDown(0.3);
  doc.fontSize(11).text(`${e.title} — ${e.company}`, { continued: true });
  doc.fontSize(10).fillColor('#555').text(`   (${e.start} – ${e.end})`);
  doc.fillColor('#000');
  for (const b of e.bullets) doc.fontSize(10).text(`• ${b}`);
}
doc.moveDown(0.8);

doc.fontSize(12).text('Education', { underline: true });
for (const ed of TEST_PROFILE.education) {
  doc
    .fontSize(10)
    .text(
      `${ed.degree} in ${ed.field}, ${ed.school} (${ed.gradYear}). GPA ${ed.gpa}`
    );
}
doc.moveDown(0.8);

doc.fontSize(12).text('Skills', { underline: true });
doc.fontSize(10).text(TEST_PROFILE.skills.join(' · '));

doc.end();
stream.on('finish', () => {
  // eslint-disable-next-line no-console
  console.log('Wrote resume to', outPath);
});
