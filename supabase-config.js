// AgendaPro — Configuração do Supabase
// Não compartilhe este arquivo publicamente.

const SUPABASE_URL = "https://mubrnxxmfxygrrumgxww.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im11YnJueHhtZnh5Z3JydW1neHd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI0NDQxMTgsImV4cCI6MjEwODAyMDExOH0.MV23F2dH2_Qr94kDHrhSisXXabx25kax5BNMpWFESfM";

const db = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
