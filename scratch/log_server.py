from http.server import BaseHTTPRequestHandler, HTTPServer
import json

class LogHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        
        try:
            log_data = json.loads(post_data.decode('utf-8'))
            print("\n[EXTENSION LOG]", log_data.get('msg'))
            if 'data' in log_data:
                print("Data:", json.dumps(log_data['data'], indent=2))
        except Exception as e:
            print("\n[EXTENSION LOG] RAW:", post_data.decode('utf-8'))
            
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'{"status":"ok"}')

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

server_address = ('', 9999)
httpd = HTTPServer(server_address, LogHandler)
print('Starting log server on port 9999...')
httpd.serve_forever()
