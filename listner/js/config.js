// Configuration for the listener app backend connection.
// IMPORTANT: For production, this MUST be your public HTTPS backend URL.
// Do not use localhost for production deployments on Vercel/Netlify.

// The app will use localhost for local testing, but you MUST change the fallback
// URL below to your actual production Render backend URL before deploying!
const BACKEND_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
  ? "http://localhost:3999" 
  : "https://your-radio-backend.onrender.com"; 
