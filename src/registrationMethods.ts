import type { RegistrationMethod, RegistrationParams } from "./types";

// Keys and defaults mirror the params.get(...) calls in scripts/register.py.
export type RegistrationParam = { key: string; label: string; hint: string } & (
    | { type: "number"; min: number; max: number; step: number; default: number }
    | { type: "select"; options: { value: string; label: string }[]; default: string }
    | { type: "boolean"; default: boolean }
    | { type: "integers"; default: string }
);

export type RegistrationMethodInfo = {
    id: RegistrationMethod;
    label: string;
    summary: string;
    help: string[];
    params: RegistrationParam[];
};

export const REGISTRATION_METHODS: RegistrationMethodInfo[] = [
    {
        id: "convexadam",
        label: "ConvexAdam",
        summary: "Fast deformable registration on MIND features.",
        help: [
            "Learn2Reg-winning method (Siebert, Hansen & Heinrich, 2021). It describes both scans with MIND self-similarity features, so it tolerates intensity differences between scans and contrast phases.",
            "A discrete coupled-convex search finds a coarse displacement on a grid, then Adam instance optimisation refines it into a smooth dense field. Deformable from the start; no separate rigid or affine stage.",
            "Runs on an NVIDIA GPU (CUDA) or Apple Silicon GPU (MPS) when available, otherwise on the CPU. On an M-series Mac, MPS is several times faster than CPU. Good default for follow-up CT/MR of the same patient.",
        ],
        params: [
            { key: "device", label: "Device", type: "select", default: "auto",
                options: [{ value: "auto", label: "Auto (CUDA → MPS → CPU)" }, { value: "cpu", label: "CPU only" }],
                hint: "Auto uses the GPU when PyTorch can see one. Choose CPU only if the GPU run fails or runs out of memory." },
            { key: "grid_sp", label: "Grid spacing", type: "number", min: 2, max: 8, step: 1, default: 6,
                hint: "Voxel spacing of the coarse convex search grid. Smaller follows finer motion but is slower." },
            { key: "disp_hw", label: "Search radius", type: "number", min: 1, max: 8, step: 1, default: 4,
                hint: "Search half-width in grid steps; the largest displacement is about radius × grid spacing voxels." },
            { key: "lambda_weight", label: "Smoothness", type: "number", min: 0, max: 5, step: 0.05, default: 1.25,
                hint: "Regularisation weight of the Adam refinement. Higher is smoother; 0 skips Adam." },
            { key: "niter", label: "Adam iterations", type: "number", min: 0, max: 1000, step: 10, default: 80,
                hint: "Number of Adam refinement steps." },
            { key: "grid_sp_adam", label: "Adam grid", type: "number", min: 1, max: 6, step: 1, default: 2,
                hint: "Voxel spacing of the displacement grid optimised by Adam." },
            { key: "smooth", label: "Final smoothing", type: "select", default: "0",
                options: [{ value: "0", label: "Off" }, { value: "3", label: "3 voxels" }, { value: "5", label: "5 voxels" }],
                hint: "Extra box-filter smoothing of the final displacement field." },
            { key: "mind_r", label: "MIND radius", type: "number", min: 1, max: 3, step: 1, default: 1,
                hint: "Patch radius of the MIND descriptor." },
            { key: "mind_d", label: "MIND dilation", type: "number", min: 1, max: 4, step: 1, default: 2,
                hint: "Neighbour distance of the MIND descriptor." },
            { key: "ic", label: "Inverse consistency", type: "boolean", default: true,
                hint: "Also registers Fixed to Moving and averages both directions for a more plausible field. About twice the convex-search time." },
        ],
    },
    {
        id: "ants",
        label: "ANTs",
        summary: "ANTsPy symmetric normalisation (SyN).",
        help: [
            "Advanced Normalization Tools through ANTsPy. SyN is a symmetric diffeomorphic registration: the deformation stays smooth and invertible, which is why it is a standard in neuroimaging and a robust general choice.",
            "Transform picks the stages: Rigid or Affine for linear alignment only; SyN = affine + deformable; SyNRA = rigid + affine + deformable; SyNOnly = deformable only; ElasticSyN = affine + elastic deformable.",
            "CPU only; slower than ConvexAdam on large volumes. Affine stages stop early once converged, so the progress bar can jump ahead.",
        ],
        params: [
            { key: "transform", label: "Transform", type: "select", default: "SyN",
                options: ["Rigid", "Affine", "SyN", "SyNRA", "SyNOnly", "ElasticSyN"].map(value => ({ value, label: value })),
                hint: "Registration stages to run." },
            { key: "aff_metric", label: "Affine metric", type: "select", default: "mattes",
                options: [{ value: "mattes", label: "Mutual information" }, { value: "GC", label: "Gradient correlation" }, { value: "meansquares", label: "Mean squares" }],
                hint: "Similarity metric of the rigid/affine stages. Mean squares only suits identical intensities." },
            { key: "syn_metric", label: "SyN metric", type: "select", default: "mattes",
                options: [{ value: "mattes", label: "Mutual information" }, { value: "CC", label: "Cross correlation" }, { value: "meansquares", label: "Mean squares" }, { value: "demons", label: "Demons" }],
                hint: "Similarity metric of the deformable stage. Cross correlation is more accurate and much slower." },
            { key: "reg_iterations", label: "SyN iterations", type: "integers", default: "40,20,0",
                hint: "Deformable iterations per level, coarse to fine, comma-separated." },
            { key: "aff_iterations", label: "Affine iterations", type: "integers", default: "2100,1200,1200,10",
                hint: "Maximum rigid/affine iterations per level, coarse to fine." },
            { key: "grad_step", label: "Gradient step", type: "number", min: 0.01, max: 1, step: 0.01, default: 0.2,
                hint: "SyN step size. Larger converges faster but can fold." },
            { key: "flow_sigma", label: "Flow sigma", type: "number", min: 0, max: 10, step: 0.5, default: 3,
                hint: "Smoothing of each update field (voxels)." },
            { key: "total_sigma", label: "Total sigma", type: "number", min: 0, max: 10, step: 0.5, default: 0,
                hint: "Smoothing of the accumulated field (voxels)." },
        ],
    },
    {
        id: "elastix",
        label: "elastix",
        summary: "itk-elastix parameter maps: rigid → affine → B-spline.",
        help: [
            "elastix (Klein & Staring) through itk-elastix. It runs the selected stages in order; each stage refines a multi-resolution pyramid with adaptive stochastic gradient descent on randomly sampled voxels.",
            "Rigid and affine stages fix global position and scale; the B-spline stage adds a free-form deformation on a control-point grid.",
            "It always runs the full iteration count, so its progress bar and ETA are the most reliable of the three.",
        ],
        params: [
            { key: "stages", label: "Stages", type: "select", default: "rigid,affine,bspline",
                options: [
                    { value: "rigid", label: "Rigid" },
                    { value: "rigid,affine", label: "Rigid → Affine" },
                    { value: "rigid,affine,bspline", label: "Rigid → Affine → B-spline" },
                    { value: "affine,bspline", label: "Affine → B-spline" },
                    { value: "bspline", label: "B-spline" },
                ],
                hint: "Parameter maps to run, in order." },
            { key: "metric", label: "Metric", type: "select", default: "AdvancedMattesMutualInformation",
                options: [
                    { value: "AdvancedMattesMutualInformation", label: "Mutual information" },
                    { value: "AdvancedNormalizedCorrelation", label: "Normalized correlation" },
                    { value: "AdvancedMeanSquares", label: "Mean squares" },
                ],
                hint: "Similarity metric for every stage." },
            { key: "iterations", label: "Iterations", type: "number", min: 16, max: 5000, step: 16, default: 256,
                hint: "Iterations per resolution level and stage." },
            { key: "resolutions", label: "Resolutions", type: "number", min: 1, max: 6, step: 1, default: 4,
                hint: "Pyramid levels, coarse to fine." },
            { key: "grid_spacing", label: "B-spline grid", type: "number", min: 2, max: 100, step: 1, default: 10,
                hint: "Final B-spline control-point spacing (voxels). Smaller allows more local deformation." },
            { key: "samples", label: "Samples", type: "number", min: 256, max: 65536, step: 256, default: 2048,
                hint: "Random voxels sampled per iteration. More is steadier but slower." },
        ],
    },
];

export function defaultRegistrationParams(method: RegistrationMethodInfo): RegistrationParams {
    return Object.fromEntries(method.params.map(param => [param.key, param.default]));
}

export function formatDuration(seconds: number) {
    const total = Math.max(Math.round(seconds), 0);
    const minutes = Math.floor(total / 60);
    return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}:${String(total % 60).padStart(2, "0")}`;
}
