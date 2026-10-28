import { buildCatalog, MISSING_PARTS_BLOCKS, type ChecklistBlock } from "./checklist";

/** Checklist de montagem: testes básicos depois que o aparelho volta da manutenção. */
const BLOCKS: readonly Omit<ChecklistBlock, "id">[] = [
  {
    title: "Display",
    items: [
      {
        id: "m-display",
        title: "Display",
        details: "Avaliar qualidade da imagem do display, se há alguma mancha ou ondulação, e testar touch.",
      },
    ],
  },
  {
    title: "Câmeras",
    items: [
      {
        id: "m-cam-frontal",
        title: "Câmera frontal",
        details: "Abrir a câmera frontal e observar se está embaçada, se foca ou se está estourando na luz.",
        failure: "câmera suja, embaçada ou com mancha.",
      },
      {
        id: "m-cam-traseira",
        title: "Câmera traseira",
        details: "Abrir a câmera traseira e observar se está embaçada, se foca ou se está estourando na luz.",
        failure: "câmera suja, embaçada ou com mancha.",
      },
    ],
  },
  {
    title: "Lentes da câmera",
    items: [
      { id: "m-lente-frontal-limpa", title: "Câmera frontal limpa" },
      { id: "m-lente-traseira-limpa", title: "Câmera traseira limpa" },
      { id: "m-lente-frontal-adesivo", title: "Câmera frontal sem adesivo" },
      { id: "m-lente-traseira-adesivo", title: "Câmera traseira sem adesivo" },
    ],
  },
  {
    title: "Áudio depois de colar",
    items: [
      {
        id: "m-alto-falante",
        title: "Alto-falante",
        details: "Depois de fechar com a cola, tocar um áudio no volume máximo.",
        failure: "som abafado.",
      },
      {
        id: "m-microfone",
        title: "Microfone",
        details: "Depois de fechar com a cola, gravar um áudio no app Gravador e ouvir.",
        failure: "áudio abafado.",
      },
    ],
  },
  {
    title: "Proximidade",
    items: [
      {
        id: "m-prox",
        title: "Sensor de proximidade",
        details: "Testar na ligação se o proximidade funciona.",
      },
    ],
  },
  {
    title: "Reiniciar",
    items: [
      {
        id: "m-reinicia",
        title: "Aparelho fica ligado por mais de 5 minutos",
        details: "Observar se o aparelho fica mais de 5 minutos ligado.",
        failure: "o aparelho reiniciou: reprovar.",
      },
    ],
  },
  ...MISSING_PARTS_BLOCKS,
  {
    title: "Conferência de IMEI",
    confirmOnly: true,
    items: [
      {
        id: "m-imei",
        title: "Conferir IMEI",
        field: "confirm",
        details: "O IMEI da caixa é o mesmo do ativo? Confirmação obrigatória para concluir.",
      },
    ],
  },
];

export const ASSEMBLY_CHECKLIST: readonly ChecklistBlock[] = buildCatalog(BLOCKS);
