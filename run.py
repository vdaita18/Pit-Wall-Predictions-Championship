"""Start Pit Wall: python run.py, then open http://localhost:5000"""
import os
import webbrowser
from threading import Timer

from pitwall.app import create_app

app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    if not os.environ.get("PITWALL_NO_BROWSER"):
        Timer(1.2, lambda: webbrowser.open("http://localhost:%d" % port)).start()
    app.run(host="127.0.0.1", port=port, debug=False)
