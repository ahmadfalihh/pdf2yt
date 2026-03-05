const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process'); // <-- Kita gunakan perintah native mesin Linux

// Ambil argumen dari GitHub Actions
const [driveFileId, style, voice, bgmFileId] = process.argv.slice(2);

// Inisialisasi API Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Inisialisasi Google OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

const TEMP_DIR = path.join(__dirname, 'temp');

async function main() {
  console.log(`🚀 Memulai proses untuk File ID: ${driveFileId}`);
  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

  try {
    // 1. DOWNLOAD PDF DARI DRIVE
    console.log('📥 Mengunduh PDF dari Google Drive...');
    const pdfPath = path.join(TEMP_DIR, 'input.pdf');
    await downloadFile(driveFileId, pdfPath);

    // 2. EKSTRAK PDF KE GAMBAR (MENGGUNAKAN NATIVE LINUX COMMAND)
    console.log('📄 Mengekstrak PDF menjadi gambar-gambar slide...');
    const imagePaths = await extractPdfToImages(pdfPath, TEMP_DIR);
    console.log(`Ditemukan ${imagePaths.length} slide.`);

    // 3. PROSES AI (TEKS & AUDIO)
    console.log('🧠 Memulai proses AI (Script & Voice)...');
    const slidesData = [];
    
    for (let i = 0; i < imagePaths.length; i++) {
      console.log(`   Memproses AI untuk slide ${i + 1}/${imagePaths.length}...`);
      const imgPath = imagePaths[i];
      
      const script = await generateScript(imgPath, style);
      
      const audioPath = path.join(TEMP_DIR, `audio_${i}.wav`);
      await generateAudio(script, voice, audioPath);
      
      slidesData.push({ image: imgPath, audio: audioPath });
      
      if (i < imagePaths.length - 1) await new Promise(r => setTimeout(r, 5000));
    }

    // 4. RENDER VIDEO DENGAN FFMPEG
    console.log('🎬 Mulai merender video (Ini mungkin memakan waktu)...');
    const outputVideoPath = path.join(TEMP_DIR, 'final_video.mp4');
    await renderVideo(slidesData, outputVideoPath);

    // 5. UPLOAD HASIL KE GOOGLE DRIVE
    console.log('☁️ Mengunggah video hasil ke Google Drive...');
    const finalVideoId = await uploadToDrive(outputVideoPath, 'Hasil_Video_Auto.mp4', 'video/mp4');
    console.log(`✅ BERHASIL! Video tersimpan di Drive dengan ID: ${finalVideoId}`);

  } catch (error) {
    console.error('❌ TERJADI KESALAHAN FATAL:', error);
    process.exit(1); 
  }
}

// ==========================================
// FUNGSI-FUNGSI PENDUKUNG (HELPERS)
// ==========================================

async function downloadFile(fileId, destPath) {
  const dest = fs.createWriteStream(destPath);
  const res = await drive.files.get({ fileId: fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    res.data.pipe(dest).on('finish', resolve).on('error', reject);
  });
}

// FUNGSI INI YANG KITA ROMBAK TOTAL!
async function extractPdfToImages(pdfPath, outputDir) {
  const prefixPath = path.join(outputDir, 'slide');
  
  // Memerintahkan server Linux langsung untuk memotong PDF ke JPEG resolusi tinggi (300 DPI)
  execSync(`pdftoppm -jpeg -r 300 "${pdfPath}" "${prefixPath}"`);
  
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('slide-') && f.endsWith('.jpg'));
  files.sort((a, b) => {
    const numA = parseInt(a.match(/\d+/)[0]);
    const numB = parseInt(b.match(/\d+/)[0]);
    return numA - numB;
  });
  
  return files.map(f => path.join(outputDir, f));
}

async function generateScript(imagePath, style) {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const imageData = fs.readFileSync(imagePath).toString("base64");
  const prompt = `Anda narator profesional. Jelaskan materi di GAMBAR SLIDE ini.\nSyarat:\n1. Jelaskan isi gambar/teks secara langsung.\n2. Gaya: ${style}.\n3. Panjang WAJIB 70-100 kata.\n4. Bahasa Indonesia natural.`;
  
  const result = await model.generateContent([
    prompt,
    { inlineData: { data: imageData, mimeType: "image/jpeg" } }
  ]);
  return result.response.text();
}

async function generateAudio(text, voiceName, outputPath) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${process.env.GEMINI_API_KEY}`;
  
  const payload = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } }
    },
    model: "gemini-2.5-flash-preview-tts"
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) throw new Error(`Gagal generate audio: ${await res.text()}`);
  
  const data = await res.json();
  const base64Audio = data.candidates[0].content.parts[0].inlineData.data;
  const audioBuffer = Buffer.from(base64Audio, 'base64');
  fs.writeFileSync(outputPath, audioBuffer);
}

async function renderVideo(slidesData, outputPath) {
  return new Promise((resolve, reject) => {
    renderSlidesSequentially(slidesData, outputPath).then(resolve).catch(reject);
  });
}

async function renderSlidesSequentially(slides, finalOutput) {
  const clipPaths = [];
  
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const clipPath = path.join(TEMP_DIR, `clip_${i}.mp4`);
    console.log(`   Merender klip ${i+1}/${slides.length}...`);
    
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(slide.image)
        .loop() 
        .input(slide.audio)
        .outputOptions([
          '-c:v libx264',
          '-tune stillimage',
          '-c:a aac',
          '-b:a 192k',
          '-pix_fmt yuv420p',
          '-shortest' 
        ])
        .save(clipPath)
        .on('end', resolve)
        .on('error', reject);
    });
    clipPaths.push(clipPath);
  }
  
  console.log('   Menggabungkan semua klip menjadi satu video utuh...');
  const concatListPath = path.join(TEMP_DIR, 'concat.txt');
  fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));
  
  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .save(finalOutput)
      .on('end', resolve)
      .on('error', reject);
  });
}

async function uploadToDrive(filePath, fileName, mimeType) {
  const fileMetadata = { name: fileName };
  const media = { mimeType: mimeType, body: fs.createReadStream(filePath) };
  
  const file = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: 'id'
  });
  return file.data.id;
}

main();
