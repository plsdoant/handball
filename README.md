# Handball

Fun little visual project where a ball spawns from the mouth and you can control it with hands and arms

## Run

```bash
python3 -m http.server 5173
```

Open http://localhost:5173 click **start camera**. Needs internet access the first time to fetch the MediaPipe runtime and models

## Play

- **Spawn a ball:** tilt head back and make a blowing motion. Press **D** to see more detailed readings
- **Hit it:** use fingers, palms, and arms. Cursor also works

| Key | Action |
| --- | --- |
| Space | Spawn a ball |
| C | Clear all balls |
| S | Toggle skeleton |
| M | Mute |
| D | Debug view: colliders, velocities, head pitch, blendshape scores |
| F | Fullscreen |
| H | Hide overlay |

