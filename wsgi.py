"""Entry point for web hosts such as PythonAnywhere.

Open mode (default): anyone with the link can view and change everything.
To require a passcode for changes instead, uncomment the PITWALL_PASSCODE line.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# os.environ["PITWALL_PASSCODE"] = "pick-a-passcode"

from pitwall.app import create_app  # noqa: E402

application = create_app()
