/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0b12',
        ember: '#ff5d5d',
        acid: '#d8ff61',
        paper: '#f5eddc'
      },
      fontFamily: {
        display: ['Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}
