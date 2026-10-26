"""Register a moving volume onto a fixed volume for the DCMViewer Registration panel.

Usage: register.py METHOD FIXED MOVING OUT FIXED_SHAPE MOVING_SHAPE [PARAMS_JSON]
  METHOD       convexadam | ants | elastix
  FIXED/MOVING raw little-endian float32 files (x fastest), shape given as "W,H,D"
  OUT          warped moving volume, raw float32 on the fixed grid
  PARAMS_JSON  optional file with method parameters; missing keys use the defaults below

Progress goes to stderr as "@progress <0..1> <message>" lines.
Voxel spacing is not passed in, so every method works in voxel units.
Install only what you use: convexAdam (pip install convexAdam), ANTs (antspyx), elastix (itk-elastix).
"""
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager

import numpy as np


def load(path, shape):
    width, height, depth = (int(value) for value in shape.split(","))
    return np.fromfile(path, dtype="<f4").reshape(depth, height, width)


def progress(fraction, message=""):
    print(f"@progress {min(max(fraction, 0.0), 1.0):.4f} {message}", file=sys.stderr, flush=True)


def integers(text, name):
    if not re.fullmatch(r"\s*\d+(\s*,\s*\d+)*\s*", str(text)):
        raise SystemExit(f"{name} must be comma-separated integers, e.g. 40,20,0.")
    return tuple(int(value) for value in str(text).split(","))


@contextmanager
def native_stdout(*parser_args):
    """Pipe what C++ libraries print to fd 1 into a "--parse" copy of this script, which reports progress.

    A reader thread would deadlock: ANTs and elastix hold the GIL while running, so nothing drains the pipe.
    """
    sys.stdout.flush()
    parser = subprocess.Popen([sys.executable, __file__, "--parse", *map(str, parser_args)],
                              stdin=subprocess.PIPE, stdout=subprocess.DEVNULL)
    saved = os.dup(1)
    os.dup2(parser.stdin.fileno(), 1)
    try:
        yield
    finally:
        sys.stdout.flush()
        os.dup2(saved, 1)
        os.close(saved)
        parser.stdin.close()
        parser.wait()


def parse_ants(lines):
    # ANTs logs "Number of stages", per-stage "iterations = 40x20x0" and a DIAGNOSTIC line per iteration.
    stages, stage, levels, level = 1, 0, [1], -1
    for line in lines:
        if match := re.search(r"Number of stages = (\d+)", line):
            stages = max(int(match[1]), 1)
        elif match := re.fullmatch(r"Stage (\d+)\s*", line):
            stage, level = int(match[1]), -1
        elif match := re.search(r"iterations = ([\dx]+)", line):
            levels = [n for n in map(int, match[1].split("x")) if n > 0] or [1]
        elif match := re.search(r"DIAGNOSTIC,\s*(\d+),", line):
            iteration = int(match[1])
            if iteration == 1:
                level += 1
            current = min(max(level, 0), len(levels) - 1)
            fraction = (stage + (current + min(iteration / levels[current], 1)) / len(levels)) / stages
            progress(0.02 + 0.95 * fraction,
                     f"Stage {stage + 1}/{stages} · level {current + 1}/{len(levels)} · iteration {iteration}")


def parse_elastix(lines, stages, total):
    # elastix logs one "<iteration>\t<metric>..." row per iteration and always runs the full count.
    stages, total, done = stages.split(","), max(int(total), 1), 0
    for line in lines:
        if re.match(r"\d+\t", line):
            done += 1
            if done % 8 == 0 or done == total:
                stage = stages[min(done * len(stages) // total, len(stages) - 1)]
                progress(0.02 + 0.95 * done / total, f"{stage.capitalize()} · iteration {done}/{total}")


def convexadam(fixed, moving, params):
    progress(0, "Loading PyTorch")
    # Ops MPS lacks run on the CPU instead of failing; must be set before torch loads.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch
    from scipy.ndimage import zoom
    from convexAdam.apply_convex import apply_convex
    from convexAdam.convex_adam_MIND import convex_adam_pt
    from torch.optim.optimizer import register_optimizer_step_post_hook

    # convexAdam needs matching grids; resample moving onto the fixed shape first.
    if moving.shape != fixed.shape:
        moving = zoom(moving, [f / m for f, m in zip(fixed.shape, moving.shape)], order=1)
    # auto: CUDA, then Apple MPS, then CPU. float16 halves memory and runs ~3x faster on MPS with the same field.
    if params.get("device", "auto") == "cpu":
        device = "cpu"
    elif torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    iterations = int(params.get("niter", 80))
    steps = 0

    # convex_adam_pt has no callback; counting Adam steps is the only progress signal inside it.
    def on_step(*_):
        nonlocal steps
        steps += 1
        if steps == 1 or steps % 5 == 0 or steps == iterations:
            progress(0.3 + 0.6 * steps / max(iterations, 1), f"Adam refinement {steps}/{iterations}")

    progress(0.02, f"MIND features and convex search ({device.upper()})")
    hook = register_optimizer_step_post_hook(on_step)
    try:
        disp = convex_adam_pt(
            fixed, moving,
            mind_r=int(params.get("mind_r", 1)), mind_d=int(params.get("mind_d", 2)),
            lambda_weight=float(params.get("lambda_weight", 1.25)),
            grid_sp=int(params.get("grid_sp", 6)), disp_hw=int(params.get("disp_hw", 4)),
            selected_niter=iterations, selected_smooth=int(params.get("smooth", 0)),
            grid_sp_adam=int(params.get("grid_sp_adam", 2)), ic=bool(params.get("ic", True)),
            dtype=torch.float32 if device == "cpu" else torch.float16,
            device=torch.device(device))
    finally:
        hook.remove()
    progress(0.95, "Warping moving volume")
    # apply_convex fills outside the moving field with 0; shift so it fills with the moving background instead.
    low = float(moving.min())
    return apply_convex(disp, moving - low) + low


def ants(fixed, moving, params):
    progress(0, "Loading ANTs")
    import ants as antspy

    progress(0.02, "Starting ANTs")
    with native_stdout("ants"):
        result = antspy.registration(
            antspy.from_numpy(fixed), antspy.from_numpy(moving),
            type_of_transform=str(params.get("transform", "SyN")),
            aff_metric=str(params.get("aff_metric", "mattes")),
            syn_metric=str(params.get("syn_metric", "mattes")),
            reg_iterations=integers(params.get("reg_iterations", "40,20,0"), "SyN iterations"),
            aff_iterations=integers(params.get("aff_iterations", "2100,1200,1200,10"), "Affine iterations"),
            grad_step=float(params.get("grad_step", 0.2)),
            flow_sigma=float(params.get("flow_sigma", 3)),
            total_sigma=float(params.get("total_sigma", 0)),
            verbose=True)
    # warpedmovout fills outside the moving field with 0; redo the warp with the moving background value.
    warped = antspy.apply_transforms(result["warpedmovout"], antspy.from_numpy(moving), result["fwdtransforms"],
                                     defaultvalue=float(moving.min()))
    return warped.numpy()


def elastix(fixed, moving, params):
    progress(0, "Loading elastix")
    import itk

    stages = [name for name in str(params.get("stages", "rigid,affine,bspline")).split(",") if name]
    iterations = int(params.get("iterations", 256))
    resolutions = int(params.get("resolutions", 4))
    metric = str(params.get("metric", "AdvancedMattesMutualInformation"))
    parameters = itk.ParameterObject.New()
    for name in stages:
        parameter_map = parameters.GetDefaultParameterMap(name)
        parameter_map["MaximumNumberOfIterations"] = [str(iterations)]
        parameter_map["NumberOfResolutions"] = [str(resolutions)]
        parameter_map["NumberOfSpatialSamples"] = [str(int(params.get("samples", 2048)))]
        parameter_map["DefaultPixelValue"] = [str(float(moving.min()))]
        # B-spline keeps its bending-energy penalty as the second metric.
        parameter_map["Metric"] = [metric, *parameter_map["Metric"][1:]]
        if name == "bspline":
            parameter_map["FinalGridSpacingInPhysicalUnits"] = [str(float(params.get("grid_spacing", 10)))]
        parameters.AddParameterMap(parameter_map)

    progress(0.02, "Starting elastix")
    with native_stdout("elastix", ",".join(stages), len(stages) * resolutions * iterations):
        warped, _ = itk.elastix_registration_method(
            itk.image_view_from_array(fixed), itk.image_view_from_array(moving),
            parameter_object=parameters, log_to_console=True)
    return itk.array_from_image(warped)


METHODS = {"convexadam": convexadam, "ants": ants, "elastix": elastix}


def main(method, fixed_path, moving_path, out_path, fixed_shape, moving_shape, params_path=None):
    if method not in METHODS:
        raise SystemExit(f"Unknown registration method: {method}")
    params = {}
    if params_path:
        with open(params_path, encoding="utf-8") as stream:
            params = json.load(stream)
    fixed = load(fixed_path, fixed_shape)
    moving = load(moving_path, moving_shape)
    warped = np.asarray(METHODS[method](fixed, moving, params), dtype="<f4")
    if warped.shape != fixed.shape:
        raise SystemExit(f"Registration returned shape {warped.shape}, expected {fixed.shape}.")
    warped.tofile(out_path)
    progress(1, "Done")


if __name__ == "__main__":
    if sys.argv[1:2] == ["--parse"]:
        lines = open(sys.stdin.fileno(), errors="replace", closefd=False)
        {"ants": parse_ants, "elastix": parse_elastix}[sys.argv[2]](lines, *sys.argv[3:])
        raise SystemExit
    if len(sys.argv) not in (7, 8):
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
