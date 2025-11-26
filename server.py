# EPUB to Audiobook Web Converter - Server Script
# Run this to start the local development server

import http.server
import socketserver
import os
import webbrowser
from functools import partial

PORT = 8090
# Serve from project root (parent of web/) to access both web/ and assets/
DIRECTORY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP Request Handler with CORS headers and proper MIME types"""
    
    extensions_map = {
        '': 'application/octet-stream',
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.mjs': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.wasm': 'application/wasm',
        '.epub': 'application/epub+zip',
        '.onnx': 'application/octet-stream',
    }
    
    def end_headers(self):
        # Add CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        # COEP/COOP headers removed to allow CDN scripts (Tailwind) to load
        # self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        # self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

def run_server():
    os.chdir(DIRECTORY)
    
    handler = partial(CORSHTTPRequestHandler, directory=DIRECTORY)
    
    with socketserver.TCPServer(("", PORT), handler) as httpd:
        url = f"http://localhost:{PORT}/web/"  # Serve from web/ subdirectory
        print(f"""
╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   📚 EPUB to Audiobook Converter                                 ║
║                                                                  ║
║   Server running at: {url:<40} ║
║                                                                  ║
║   Press Ctrl+C to stop the server                               ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
        """)
        
        # Open browser automatically
        webbrowser.open(url)
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n👋 Server stopped. Goodbye!")

if __name__ == "__main__":
    run_server()
