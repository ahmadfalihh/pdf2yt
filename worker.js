const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Ambil 7 Argumen dari GitHub Actions
const [driveFileId, style, voice, bgmFileId, apiKeysList, slideDelayStr, targetFolderId] = process.argv.slice(2);

// Setup Rotasi API Key & Jeda
const apiKeys = apiKeysList.split(',').filter(k => k.trim() !== '');
const slideDelayMs = (parseInt(slideDelayStr) || 15) * 1000;
let currentKeyIndex = 0;

function getNextApiKey() {
  const key = apiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  return key;
}

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
    console.log('📥 Mengunduh PDF dari Google Drive...');
    const pdfPath = path.join(TEMP_DIR, 'input.pdf');
    await downloadFile(driveFileId, pdfPath);

    let bgmPath = null;
    if (bgmFileId && bgmFileId !== 'NONE') {
      console.log('🎵 Mengunduh Musik Latar (BGM)...');
      bgmPath = path.join(TEMP_DIR, 'bgm.mp3');
      await downloadFile(bgmFileId, bgmPath);
    }

    console.log('📄 Mengekstrak PDF menjadi gambar...');
    const imagePaths = await extractPdfToImages(pdfPath, TEMP_DIR);
    console.log(`Ditemukan ${imagePaths.length} slide.`);

    console.log(`🧠 Memulai AI dengan ${apiKeys.length} Kunci Rotasi & Jeda ${slideDelayStr} detik...`);
    const slidesData = [];
    
    for (let i = 0; i < imagePaths.length; i++) {
      console.log(`   Memproses AI untuk slide ${i + 1}/${imagePaths.length}...`);
      const imgPath = imagePaths[i];
      const audioPath = path.join(TEMP_DIR, `audio_${i}.wav`);
      
      let success = false;
      let retries = 0;
      let usedKey = getNextApiKey();

      while (!success && retries < 3) {
        try {
          const script = await generateScript(imgPath, style, usedKey);
          await generateAudio(script, voice, audioPath, usedKey);
          slidesData.push({ image: imgPath, audio: audioPath });
          success = true;
        } catch (error) {
          if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')) {
            console.log(`   ⚠️ Kunci API Limit (429). Rotasi Kunci & Istirahat 15 detik (Coba ${retries + 1}/3)...`);
            usedKey = getNextApiKey(); // Tukar kunci
            await new Promise(r => setTimeout(r, 15000));
            retries++;
          } else {
            throw error;
          }
        }
      }

      if (!success) throw new Error(`Gagal memproses slide ${i + 1} setelah 3 kali mencoba.`);
      
      // Jeda Dinamis Antar Slide
      if (i < imagePaths.length - 1) await new Promise(r => setTimeout(r, slideDelayMs));
    }

    console.log('🎬 Mulai merender video utuh...');
    const outputVideoPath = path.join(TEMP_DIR, 'final_video.mp4');
    await renderVideo(slidesData, outputVideoPath, bgmPath);

    console.log('☁️ Mengunggah video hasil ke Google Drive...');
    const finalVideoName = `Video_Auto_${Date.now()}.mp4`;
    const finalVideoId = await uploadToDrive(outputVideoPath, finalVideoName, 'video/mp4', targetFolderId);
    
    console.log(`✅ BERHASIL Sempurna! Video tersimpan di Drive dengan ID: ${finalVideoId}`);

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
  return new Promise((resolve, reject) => res.data.pipe(dest).on('finish', resolve).on('error', reject));
}

async function extractPdfToImages(pdfPath, outputDir) {
  const prefixPath = path.join(outputDir, 'slide');
  execSync(`pdftoppm -jpeg -r 300 "${pdfPath}" "${prefixPath}"`);
  const files = fs.readdirSync(outputDir).filter(f => f.startsWith('slide-') && f.endsWith('.jpg'));
  files.sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  return files.map(f => path.join(outputDir, f));
}

async function generateScript(imagePath, style, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const imageData = fs.readFileSync(imagePath).toString("base64");
  const prompt = `Anda narator profesional. Jelaskan materi di GAMBAR SLIDE ini.\nSyarat:\n1. Jelaskan isi gambar/teks secara langsung.\n2. Gaya: ${style}.\n3. Panjang WAJIB 70-100 kata.\n4. Bahasa Indonesia natural.`;
  
  const result = await model.generateContent([ prompt, { inlineData: { data: imageData, mimeType: "image/jpeg" } } ]);
  return result.response.text();
}

async function generateAudio(text, voiceName, outputPath, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } } },
    model: "gemini-2.5-flash-preview-tts"
  };

  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`429: Gagal generate audio - ${await res.text()}`); 
  
  const data = await res.json();
  fs.writeFileSync(outputPath, Buffer.from(data.candidates[0].content.parts[0].inlineData.data, 'base64'));
}

async function renderVideo(slides, finalOutput, bgmPath) {
  const clipPaths = [];
  
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const clipPath = path.join(TEMP_DIR, `clip_${i}.mp4`);
    console.log(`   Merender klip ${i+1}/${slides.length}...`);
    
    await new Promise((resolve, reject) => {
      ffmpeg().input(slide.image).loop().input(slide.audio)
        .outputOptions(['-c:v libx264', '-tune stillimage', '-c:a aac', '-b:a 192k', '-pix_fmt yuv420p', '-shortest'])
        .save(clipPath).on('end', resolve).on('error', reject);
    });
    clipPaths.push(clipPath);
  }
  
  console.log('   Menyatukan semua klip...');
  const concatListPath = path.join(TEMP_DIR, 'concat.txt');
  fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));
  
  const rawVideoPath = path.join(TEMP_DIR, 'raw_video.mp4');
  await new Promise((resolve, reject) => {
    ffmpeg().input(concatListPath).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy')
      .save(rawVideoPath).on('end', resolve).on('error', reject);
  });

  // Jika ada BGM, campur volumenya menjadi 15% di background
  if (bgmPath) {
    console.log('   Mencampur Musik Latar (BGM)...');
    await new Promise((resolve, reject) => {
      ffmpeg().input(rawVideoPath).input(bgmPath)
        .complexFilter(['[1:a]volume=0.15[bgm]', '[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=2[aout]'])
        .outputOptions(['-map 0:v', '-map [aout]', '-c:v copy', '-c:a aac', '-b:a 192k'])
        .save(finalOutput).on('end', resolve).on('error', reject);
    });
  } else {
    fs.copyFileSync(rawVideoPath, finalOutput);
  }
}

async function uploadToDrive(filePath, fileName, mimeType, folderId) {
  const fileMetadata = { name: fileName };
  if (folderId && folderId !== 'NONE') fileMetadata.parents = [folderId]; // Masukkan ke folder terpilih
  
  const media = { mimeType: mimeType, body: fs.createReadStream(filePath) };
  const file = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });
  return file.data.id;
}

main();
