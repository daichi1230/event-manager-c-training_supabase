import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase environment variables are not set. Please create .env.local from .env.example.');
}

export const supabase = createClient(supabaseUrl ?? 'https://example.supabase.co', supabaseKey ?? 'public-anon-key');
