// Image chats: each family of image models has a workflow of its own, the graph
// ComfyUI runs to make a picture with it. Each one follows ComfyUI's official
// template for that family, named in `template`, and does one or more of the modes:
// make a picture from text, remake one, edit one, or upscale one.
//
// A workflow runs a model when ComfyUI has the model's file and every other file
// the graph loads, such as its text encoder and VAE. Files are told apart by name.
import { comfyFiles, type ComfyFolder } from "./comfy.ts";

export type ImageMode = "txt2img" | "img2img" | "edit" | "upscale";

interface Need {
  folder: ComfyFolder;
  match: RegExp;
  /** What to tell the user is missing. */
  label: string;
}

interface Workflow {
  id: string;
  name: string;
  detail: string;
  modes: ImageMode[];
  /** ComfyUI's template it follows, or the custom nodes when there is none. */
  template: string;
  /** The files it can run, and the folders they're in. */
  models: { folders: ComfyFolder[]; match: RegExp };
  needs: Need[];
}

const DIFFUSION: ComfyFolder[] = ["diffusion", "gguf"];
// Every model that makes pictures can also remake one, starting from it rather than from noise.
const MAKE: ImageMode[] = ["txt2img", "img2img"];

const SDXL = /illustri|juggernaut|pony|sdxl|xl\b|_xl/i;
const ae: Need = { folder: "vae", match: /^ae\./i, label: "ae (Flux VAE)" };
const flux2Vae: Need = { folder: "vae", match: /^flux2-vae\./i, label: "flux2-vae" };
const clipL: Need = { folder: "textEncoder", match: /^clip_l\./i, label: "clip_l" };
const t5: Need = { folder: "textEncoder", match: /t5xxl/i, label: "t5xxl" };
const qwen3_4b: Need = { folder: "textEncoder", match: /qwen[_-]?3[_-]4b/i, label: "Qwen3 4B" };
const qwen3_8b: Need = { folder: "textEncoder", match: /qwen[_-]?3[_-]8b/i, label: "Qwen3 8B" };
const qwen35_9b: Need = { folder: "textEncoder", match: /qwen3\.5[_-]9b/i, label: "Qwen3.5 9B" };
const mossVae: Need = { folder: "vae", match: /flux2-vae_small/i, label: "flux2-vae_small" };
const minimaxNeeds: Need[] = [
  { folder: "textEncoder", match: /qwen3vl_32b_minimax_h3/i, label: "qwen3vl_32b_minimax_h3" },
  { folder: "vae", match: /minimax_h3_image_vae/i, label: "minimax_h3_image_vae" },
];

export const WORKFLOWS: Workflow[] = [
  // Making and remaking pictures.
  {
    id: "sdxl", name: "SDXL", detail: "SDXL, Illustrious and Pony checkpoints", modes: MAKE, template: "image_sdxl_simple",
    models: { folders: ["checkpoint"], match: SDXL },
    needs: [],
  },
  {
    id: "sd15", name: "SD 1.5", detail: "Stable Diffusion 1.5 checkpoints", modes: MAKE, template: "01_get_started_text_to_image",
    models: { folders: ["checkpoint"], match: /v1-5|sd-?1\.?5/i },
    needs: [],
  },
  {
    id: "flux-dev", name: "Flux.1 dev", detail: "Detailed, about 20 steps", modes: MAKE, template: "flux_dev_full_text_to_image",
    models: { folders: DIFFUSION, match: /^flux1-dev/i },
    needs: [clipL, t5, ae],
  },
  {
    id: "flux-schnell", name: "Flux.1 schnell", detail: "Fast, 4 steps", modes: MAKE, template: "flux_schnell_full_text_to_image",
    models: { folders: DIFFUSION, match: /^flux1-schnell/i },
    needs: [clipL, t5, ae],
  },
  {
    id: "chroma", name: "Chroma", detail: "Flux-based, no content filter", modes: MAKE, template: "image_chroma_text_to_image",
    models: { folders: DIFFUSION, match: /chroma/i },
    needs: [t5, ae],
  },
  {
    id: "z-image-turbo", name: "Z-Image Turbo", detail: "Fast and photoreal, 8 steps", modes: MAKE, template: "image_z_image_turbo",
    models: { folders: DIFFUSION, match: /z[_-]image[_-]turbo/i },
    needs: [qwen3_4b, ae],
  },
  {
    id: "ernie-turbo", name: "ERNIE-Image Turbo", detail: "Fast, good with text in pictures", modes: MAKE, template: "image_ernie_image_turbo",
    models: { folders: DIFFUSION, match: /ernie-image-turbo/i },
    needs: [{ folder: "textEncoder", match: /ministral-3-3b/i, label: "ministral-3-3b" }, flux2Vae],
  },
  {
    id: "krea2-turbo", name: "Krea 2 Turbo", detail: "Fast, strong on style", modes: MAKE, template: "image_krea2_turbo_t2i",
    models: { folders: DIFFUSION, match: /krea2[_-]turbo/i },
    needs: [{ folder: "textEncoder", match: /qwen3vl_4b/i, label: "qwen3vl_4b" }, { folder: "vae", match: /qwen_image_vae/i, label: "qwen_image_vae" }],
  },
  {
    id: "ideogram4", name: "Ideogram 4", detail: "Text and layout in pictures", modes: MAKE, template: "image_ideogram4_t2i",
    // The unconditional model isn't one to pick: the graph loads it beside the main one.
    models: { folders: DIFFUSION, match: /^ideogram4_(?!unconditional)/i },
    needs: [
      { folder: "diffusion", match: /ideogram4_unconditional/i, label: "ideogram4_unconditional" },
      { folder: "textEncoder", match: /qwen3vl_8b/i, label: "qwen3vl_8b" },
      flux2Vae,
    ],
  },
  {
    id: "flux2-klein-9b", name: "Flux.2 klein 9B", detail: "Fast, 4 steps", modes: MAKE, template: "image_flux2_text_to_image_9b",
    models: { folders: DIFFUSION, match: /flux-2-klein-(base-)?9b/i },
    needs: [qwen3_8b, flux2Vae],
  },
  {
    id: "moss", name: "Moss Image", detail: "Photoreal", modes: MAKE, template: "image_moss_image_base_t2i",
    models: { folders: DIFFUSION, match: /^moss_image/i },
    needs: [qwen35_9b, mossVae],
  },
  {
    id: "minimax-h3-image", name: "MiniMax H3 Image", detail: "Large and slow on 24 GB", modes: MAKE, template: "image_minimax_h3_image_t2i",
    models: { folders: DIFFUSION, match: /^minimax_h3_image/i },
    needs: minimaxNeeds,
  },

  // Editing a picture from an instruction, or filling in part of it.
  {
    id: "flux-kontext", name: "Flux.1 Kontext dev", detail: "Edits from an instruction", modes: ["edit"], template: "flux_kontext_dev_basic",
    models: { folders: DIFFUSION, match: /^flux1-(dev-)?kontext/i },
    needs: [clipL, t5, ae],
  },
  {
    id: "flux-fill", name: "Flux.1 Fill dev", detail: "Fills in a masked part, or past the edges", modes: ["edit"], template: "flux_fill_inpaint_example",
    models: { folders: DIFFUSION, match: /^flux1-fill/i },
    needs: [clipL, t5, ae],
  },
  {
    id: "flux2-klein-9b-edit", name: "Flux.2 klein 9B", detail: "Edits from an instruction, 4 steps", modes: ["edit"], template: "image_flux2_klein_image_edit_9b_distilled",
    models: { folders: DIFFUSION, match: /flux-2-klein-(base-)?9b/i },
    needs: [qwen3_8b, flux2Vae],
  },
  {
    id: "moss-edit", name: "Moss Image", detail: "Edits from an instruction", modes: ["edit"], template: "image_moss_image_edit",
    models: { folders: DIFFUSION, match: /^moss_image/i },
    needs: [qwen35_9b, mossVae, { folder: "lora", match: /moss_image_edit/i, label: "moss_image_edit LoRA" }],
  },
  {
    id: "minimax-h3-edit", name: "MiniMax H3 Image", detail: "Edits from an instruction, slow", modes: ["edit"], template: "image_minimax_h3_image_edit",
    models: { folders: DIFFUSION, match: /^minimax_h3_image/i },
    needs: minimaxNeeds,
  },

  // Making a picture bigger.
  {
    id: "upscale-model", name: "Upscale model", detail: "ESRGAN-style, fast, 4x", modes: ["upscale"], template: "utility-gan_upscaler",
    models: { folders: ["upscale"], match: /./ },
    needs: [],
  },
  {
    id: "supir", name: "SUPIR", detail: "Restores detail with an SDXL checkpoint, slow", modes: ["upscale"], template: "comfyui-supir nodes",
    models: { folders: ["checkpoint"], match: /supir/i },
    needs: [{ folder: "checkpoint", match: SDXL, label: "an SDXL checkpoint" }],
  },
  {
    id: "z-image-upscale", name: "Z-Image Turbo 2K", detail: "Upscales, then redraws the detail", modes: ["upscale"], template: "utility_z_image_turbo_2k_upscaler.app",
    models: { folders: DIFFUSION, match: /z[_-]image[_-]turbo/i },
    needs: [qwen3_4b, ae, { folder: "upscale", match: /./, label: "an upscale model" }],
  },
];

const MODEL_FOLDERS: ComfyFolder[] = ["checkpoint", "diffusion", "gguf"];

const basename = (file: string) => file.split(/[\\/]/).pop()!;

/** Each workflow with the files it can run and what it lacks, then the model files no workflow takes. */
export async function imageWorkflows(base: string) {
  const files = await comfyFiles(base);
  const taken = new Set<string>();
  const workflows = WORKFLOWS.map(({ id, name, detail, modes, models, needs }) => {
    const found = models.folders.flatMap((folder) =>
      files[folder].filter((file) => models.match.test(basename(file))).map((file) => ({ file, folder })),
    );
    for (const m of found) taken.add(`${m.folder}/${m.file}`);
    for (const need of needs) for (const file of files[need.folder]) if (need.match.test(basename(file))) taken.add(`${need.folder}/${file}`);
    const missing = needs.filter((need) => !files[need.folder].some((file) => need.match.test(basename(file)))).map((need) => need.label);
    return { id, name, detail, modes, models: found, missing };
  });
  const other = MODEL_FOLDERS.flatMap((folder) => files[folder].filter((file) => !taken.has(`${folder}/${file}`)).map((file) => ({ file, folder })));
  return { workflows, other };
}
