# AI Chat (ChatGPT-like)

Fullstack real-time AI chat: Node.js + Express + Socket.io + MySQL + bcrypt + express-session.

## Cara menjalankan

1. Pastikan **MySQL** sudah berjalan di `localhost:3306` (user `root`, password kosong).
   Jika berbeda, edit `config.js`.
2. Install & start:

```bash
npm install
npm start
```

3. Buka `http://localhost:3000`

Database `ai_chat` dan tabel akan dibuat otomatis saat pertama kali start.

## Struktur

```
/project-root
  config.js
  server.js
  package.json
  /public
    index.html
    style.css
    app.js
```

## Fitur

- Login / Register (bcrypt + session)
- Multi-conversation seperti ChatGPT
- Real-time streaming AI typing (Socket.io)
- Riwayat tersimpan di MySQL per user
- Responsive desktop & mobile (sidebar collapsible)
- Logout menghapus session
