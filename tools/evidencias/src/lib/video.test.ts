import { describe, expect, it } from "vitest";
import { argumentosH264, filtroH264, filtroLoudnorm, leerAstats, leerEbur128, leerFfprobe, leerLoudnorm, nombresVideo, racional } from "./video.js";

const EBUR128 = `[Parsed_ebur128_0 @ 0x55d] t: 19.9 TARGET:-23 LUFS M: -18.3 S: -18.1 I: -17.9 LUFS LRA: 4.4 LU FTPK: -6.2 dBFS TPK: -5.0 dBFS
[Parsed_ebur128_0 @ 0x55d] Summary:

  Integrated loudness:
    I:         -18.0 LUFS
    Threshold: -28.4 LUFS

  Loudness range:
    LRA:         4.4 LU
    Threshold: -38.3 LUFS
    LRA low:   -19.9 LUFS
    LRA high:  -15.5 LUFS

  True peak:
    Peak:       -5.0 dBFS
`;

const ASTATS = `[Parsed_astats_0 @ 0x1] Channel: 1
[Parsed_astats_0 @ 0x1] Peak level dB: -5.1
[Parsed_astats_0 @ 0x1] Overall
[Parsed_astats_0 @ 0x1] DC offset: -0.000011
[Parsed_astats_0 @ 0x1] Max difference: 0.049213
[Parsed_astats_0 @ 0x1] Peak level dB: -4.971281
[Parsed_astats_0 @ 0x1] RMS level dB: -19.465743
[Parsed_astats_0 @ 0x1] Flat factor: 0.000000
`;

describe("lectura de mediciones de ffmpeg", () => {
  it("ebur128: integrado, rango y pico real del resumen", () => {
    expect(leerEbur128(EBUR128)).toEqual({ integrado: -18, lra: 4.4, picoReal: -5 });
    expect(() => leerEbur128("nada")).toThrow(/ebur128/);
  });

  it("astats: sección Overall", () => {
    expect(leerAstats(ASTATS)).toEqual({ picoDb: -4.971281, rmsDb: -19.465743, dc: -0.000011, saltoMaximo: 0.049213, factorPlano: 0 });
  });

  it("loudnorm: el último JSON impreso y el filtro de la segunda pasada (lineal)", () => {
    const m = leerLoudnorm(`ruido {no} [Parsed_loudnorm_0 @ 0x1]\n{\n\t"input_i" : "-20.53",\n\t"input_tp" : "-6.00",\n\t"input_lra" : "4.20",\n\t"input_thresh" : "-30.90",\n\t"target_offset" : "0.12"\n}\n`);
    expect(m.input_i).toBe("-20.53");
    const f = filtroLoudnorm(m);
    expect(f).toContain("I=-18:TP=-2:LRA=20");
    expect(f).toContain("measured_I=-20.53:measured_TP=-6.00:measured_LRA=4.20:measured_thresh=-30.90:offset=0.12");
    expect(f).toContain("linear=true");
    expect(() => filtroLoudnorm({ input_i: "-20" })).toThrow(/input_tp/);
    expect(() => leerLoudnorm("sin json")).toThrow(/loudnorm/);
  });

  it("ffprobe: video, audio, cps y etiquetas", () => {
    const info = leerFfprobe({
      streams: [
        { codec_type: "video", codec_name: "h264", profile: "High", width: 1920, height: 1080, pix_fmt: "yuv420p", r_frame_rate: "30/1", avg_frame_rate: "30/1", nb_frames: "600" },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, bit_rate: "158670", duration: "20.0" },
      ],
      format: { duration: "20.021333", size: "22011795", format_name: "mov,mp4,m4a,3gp,3g2,mj2", bit_rate: "8795000", tags: { TITLE: "x", comment: "Yago Nexo 1.2.0" } },
    });
    expect(info).toMatchObject({ duracion: 20.021333, cuadros: 600, ancho: 1920, alto: 1080, codec: "h264", cps: 30, cpsMedio: 30, pixFmt: "yuv420p", bytes: 22011795 });
    expect(info.audio).toEqual({ codec: "aac", frecuencia: 48000, canales: 2, kbps: 158.67, duracion: 20 });
    expect(info.etiquetas).toEqual({ title: "x", comment: "Yago Nexo 1.2.0" });
    expect(leerFfprobe({}).audio).toBeUndefined();
  });

  it("racional", () => {
    expect(racional("30000/1001")).toBeCloseTo(29.97, 2);
    expect(racional("0/0")).toBeUndefined();
    expect(racional(undefined)).toBeUndefined();
  });
});

describe("parámetros de codificación", () => {
  it("H.264 yuv420p, CRF 20, GOP de 2 s, BT.709, +faststart y sin audio", () => {
    const a = argumentosH264().join(" ");
    expect(a).toContain("-c:v libx264");
    expect(a).toContain("-crf 20");
    expect(a).toContain("-pix_fmt yuv420p");
    expect(a).toContain("-g 60");
    expect(a).toContain("-colorspace bt709");
    expect(a).toContain("-movflags +faststart");
    expect(a).toContain("-an");
    expect(argumentosH264({ cps: 25, crf: 22 }).join(" ")).toMatch(/-crf 22 .*-g 50/);
    expect(filtroH264()).toBe("scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv,fps=30,format=yuv420p");
    expect(filtroH264({ ancho: 1600, alto: 900, cps: 25 })).toMatch(/^scale=1600:900:.*fps=25,/);
  });

  it("nombres de los archivos de un video", () => {
    expect(nombresVideo("D-01_descubrimiento")).toEqual({
      video: "D-01_descubrimiento.mp4",
      sinMusica: "D-01_descubrimiento.sin-musica.mp4",
      portada: "D-01_descubrimiento.jpg",
      pasos: "D-01_descubrimiento.pasos.json",
      subtitulos: "D-01_descubrimiento.vtt",
      capitulos: "D-01_descubrimiento.capitulos.vtt",
    });
  });
});
