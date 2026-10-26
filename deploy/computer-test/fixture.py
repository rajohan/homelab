"""Disposable Tk fixture. Only its own state is used to verify delivered input."""

import json
import os
from pathlib import Path
import tkinter as tk

root = tk.Tk()
root.title("Mira isolated input fixture")
root.geometry("500x300+20+20")
text = tk.StringVar()
count = 0
state_path = Path("/tmp/mira-computer-fixture/state.json")


def save():
    state = {
        "pid": os.getpid(),
        "executable": os.path.realpath("/proc/self/exe"),
        "text": text.get(),
        "count": count,
        "entry": {"x": entry.winfo_x() + 20, "y": entry.winfo_y() + 10},
        "button": {"x": button.winfo_x() + 20, "y": button.winfo_y() + 10},
    }
    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state))
    temporary.replace(state_path)


def increment():
    global count
    count += 1
    label.configure(text=str(count))
    save()


entry = tk.Entry(root, textvariable=text)
entry.pack(pady=25)
button = tk.Button(root, text="Increment", command=increment)
button.pack()
label = tk.Label(root, text="0")
label.pack()
root.wait_visibility()
root.update()
text.trace_add("write", lambda *_: save())
save()
root.mainloop()
