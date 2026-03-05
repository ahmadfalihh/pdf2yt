const { GoogleGenerativeAI } = require('@google/generative-ai');
const { google } = require('googleapis');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const [driveFileId, style, voice, bgmFileId, apiKeysList, slideDelayStr, targetFolderId] = process.argv.slice(2);

const apiKeys = apiKeysList.split(',').filter(k => k.trim() !== '');
const slideDelayMs = (parseInt(slideDelayStr) || 15) * 1000;
let currentKeyIndex = 0;

function getNextApiKey() {
  const key = apiKeys[currentKeyIndex];
  currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
  return key;
}

// Inisialisasi Google OAuth2 (Drive & YouTube)
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const drive = google.drive({ version: 'v3', auth: oauth2Client });
const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

const TEMP_DIR = path.join(__dirname, 'temp');

async function main() {
  console.log(`🚀 Memulai proses otomatisasi penuh...`);
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
    const thumbnailPath = imagePaths[0]; // Slide pertama otomatis jadi thumbnail

    console.log(`🧠 Memulai proses AI Text-to-Speech...`);
    const slidesData = [];
    let fullScriptText = ""; 
    
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
          
          fullScriptText += script + "\n\n";
          slidesData.push({ image: imgPath, audio: audioPath });
          success = true;
        } catch (error) {
          if (error.message.includes('429') || error.message.includes('RESOURCE_EXHAUSTED')) {
            console.log(`   ⚠️ Kunci API Limit (429). Rotasi Kunci & Istirahat 15 detik...`);
            usedKey = getNextApiKey(); 
            await new Promise(r => setTimeout(r, 15000));
            retries++;
          } else {
            throw error;
          }
        }
      }

      if (!success) throw new Error(`Gagal memproses slide ${i + 1} setelah 3 kali mencoba.`);
      if (i < imagePaths.length - 1) await new Promise(r => setTimeout(r, slideDelayMs));
    }

    console.log('🎬 Mulai merender video utuh...');
    const outputVideoPath = path.join(TEMP_DIR, 'final_video.mp4');
    await renderVideo(slidesData, outputVideoPath, bgmPath);

    console.log('☁️ Mengunggah ke Google Drive...');
    const finalVideoName = `Video_Auto_${Date.now()}.mp4`;
    const finalVideoId = await uploadToDrive(outputVideoPath, finalVideoName, 'video/mp4', targetFolderId);
    
    // --- FITUR YOUTUBE & SEO ---
    console.log('📝 Gemini sedang menyusun Judul, Deskripsi SEO, dan Tags YouTube...');
    const seoData = await generateYouTubeMetadata(fullScriptText, getNextApiKey());
    
    console.log(`▶️ Mengunggah ke YouTube dengan judul: "${seoData.title}"...`);
    const ytVideoId = await uploadToYouTube(outputVideoPath, seoData, thumbnailPath);
    const ytLink = `https://youtu.be/${ytVideoId}`;
    console.log(`✅ BERHASIL! Video tayang di: ${ytLink}`);

    // --- FITUR NOTIFIKASI WA ---
    console.log('📱 Mengirim Notifikasi WhatsApp...');
    const waMessage = `🎉 *Render & Upload Selesai!*\n\n*Judul:* ${seoData.title}\n*Status:* Berhasil diunggah ke Drive & YouTube\n*Link YouTube:* ${ytLink}`;
    await sendWhatsAppNotification(waMessage);

    console.log('🎉 SEMUA PROSES SELESAI SEMPURNA!');

  } catch (error) {
    console.error('❌ TERJADI KESALAHAN FATAL:', error);
    await sendWhatsAppNotification(`❌ *ERROR SISTEM*\n\nTerjadi kegagalan saat memproses video otomatis. Silakan cek log di GitHub Actions.`);
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
  const prompt = `Anda narator profesional. Jelaskan materi di GAMBAR SLIDE ini secara langsung.\nGaya: ${style}.\nPanjang: 70-100 kata.\nBahasa: Indonesia.`;
  const result = await model.generateContent([ prompt, { inlineData: { data: imageData, mimeType: "image/jpeg" } } ]);
  return result.response.text();
}

// FUNGSI BARU: Mengubah PCM Mentah menjadi File WAV yang valid agar FFmpeg tidak error
function pcmToWavBuffer(pcmData, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcmData.length;

  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmData.copy(buffer, 44);

  return buffer;
}

async function generateAudio(text, voiceName, outputPath, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${apiKey}`;
  const payload = {
    contents: [{ parts: [{ text: text }] }],
    generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } } } },
    model: "gemini-2.5-flash-preview-tts"
  };
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`429: Gagal generate audio`); 
  const data = await res.json();
  
  // Perbaikan FFmpeg Error 183: Tambahkan Header WAV ke audio PCM mentah
  const pcmBuffer = Buffer.from(data.candidates[0].content.parts[0].inlineData.data, 'base64');
  const wavBuffer = pcmToWavBuffer(pcmBuffer, 24000);
  fs.writeFileSync(outputPath, wavBuffer);
}

async function renderVideo(slides, finalOutput, bgmPath) {
  const clipPaths = [];
  for (let i = 0; i < slides.length; i++) {
    const clipPath = path.join(TEMP_DIR, `clip_${i}.mp4`);
    await new Promise((resolve, reject) => {
      ffmpeg().input(slides[i].image).loop().input(slides[i].audio)
        .outputOptions(['-c:v libx264', '-tune stillimage', '-c:a aac', '-b:a 192k', '-pix_fmt yuv420p', '-shortest'])
        .save(clipPath).on('end', resolve).on('error', reject);
    });
    clipPaths.push(clipPath);
  }
  
  const concatListPath = path.join(TEMP_DIR, 'concat.txt');
  fs.writeFileSync(concatListPath, clipPaths.map(p => `file '${p}'`).join('\n'));
  
  const rawVideoPath = path.join(TEMP_DIR, 'raw_video.mp4');
  await new Promise((resolve, reject) => {
    ffmpeg().input(concatListPath).inputOptions(['-f concat', '-safe 0']).outputOptions('-c copy')
      .save(rawVideoPath).on('end', resolve).on('error', reject);
  });

  if (bgmPath) {
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
  if (folderId && folderId !== 'NONE') fileMetadata.parents = [folderId];
  const file = await drive.files.create({ resource: fileMetadata, media: { mimeType: mimeType, body: fs.createReadStream(filePath) }, fields: 'id' });
  return file.data.id;
}

async function generateYouTubeMetadata(fullScript, apiKey) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const prompt = `Anda adalah pakar SEO YouTube. Buatkan metadata untuk video berdasarkan skrip narasi berikut ini.
  
  ATURAN WAJIB:
  1. Judul: Menarik, clickbait tapi relevan, SEO friendly (Maksimal 80 karakter).
  2. Deskripsi: Tulis 300 - 500 kata yang merangkum isi video dengan bahasa yang menarik. Di akhir deskripsi, tambahkan 5 hashtag (#) yang sedang trending dan sangat relevan.
  3. Tags: Berikan 15 kata kunci pencarian yang sangat relevan, pisahkan dengan koma.

  KEMBALIKAN HANYA DALAM FORMAT JSON SEPERTI INI TANPA TEKS LAIN/MARKDOWN:
  {
    "title": "Judul Video",
    "description": "Deskripsi panjang...",
    "tags": ["tag1", "tag2", "tag3"]
  }

  SKRIP VIDEO:
  ${fullScript}`;

  const result = await model.generateContent(prompt);
  let text = result.response.text();
  text = text.replace(/```json/gi, '').replace(/```/gi, '').trim();
  return JSON.parse(text);
}

async function uploadToYouTube(videoPath, seoData, thumbnailPath) {
  const res = await youtube.videos.insert({
    part: 'snippet,status',
    requestBody: {
      snippet: {
        title: seoData.title,
        description: seoData.description,
        tags: seoData.tags,
        categoryId: '27' 
      },
      status: {
        privacyStatus: 'private', 
        selfDeclaredMadeForKids: false
      }
    },
    media: { body: fs.createReadStream(videoPath) }
  });

  const videoId = res.data.id;
  try {
    await youtube.thumbnails.set({
      videoId: videoId,
      media: { body: fs.createReadStream(thumbnailPath) }
    });
  } catch (e) {
    console.log("⚠️ Peringatan: Thumbnail gagal diunggah, tapi video tetap tayang.", e.message);
  }

  return videoId;
}

async function sendWhatsAppNotification(message) {
  const phone = process.env.WA_PHONE; 
  const apiKey = process.env.WA_API_KEY; 
  
  if (!phone || !apiKey) {
    console.log("⚠️ Lewati notifikasi WA karena kredensial WA belum diatur di GitHub Secrets.");
    return;
  }

  const url = `https://api.callmebot.com/whatsapp.php?phone=${phone}&text=${encodeURIComponent(message)}&apikey=${apiKey}`;
  try {
    await fetch(url);
  } catch (e) {
    console.log("⚠️ Gagal mengirim notifikasi WA.");
  }
}

main();
