import { buildCatalog, CHECKLIST, type ChecklistBlock } from "./checklist";

/** Desmontagem: testes com o aparelho aberto. */
const BLOCKS: readonly Omit<ChecklistBlock, "id">[] = [
  {
    title: "Teste de display",
    items: [
      {
        id: "d-display",
        title: "Display",
        details:
          "Ligar o aparelho com o display solto da carcaça e testar se está funcional e sem manchas, ondulações ou marcas de espátula.",
      },
    ],
  },
  {
    title: "Sensor de proximidade",
    items: [
      {
        id: "d-prox",
        title: "Sensor de proximidade",
        details:
          "Com o telefone aberto, retirar o sensor de proximidade da tela, fazer uma ligação e aproximar a mão do proximidade para confirmar que ele ainda funciona.",
      },
    ],
  },
  {
    title: "Confirmar serial",
    confirmOnly: true,
    items: [
      {
        id: "d-serial",
        title: "Confirmar serial",
        field: "confirm",
        details: "O serial do aparelho é o mesmo do ativo? Confirmação obrigatória para concluir.",
      },
    ],
  },
];

export const DISASSEMBLY_CHECKLIST: readonly ChecklistBlock[] = buildCatalog(BLOCKS);

/** Desmontagem técnica: o checklist de manutenção mais o teste na fonte de bancada. */
export const TECHNICAL_DISASSEMBLY_CHECKLIST: readonly ChecklistBlock[] = [
  ...CHECKLIST,
  ...buildCatalog([
    {
      title: "Fonte de bancada",
      noPointing: true,
      items: [{ id: "d-fonte", title: "Fonte de bancada", details: "Testar o consumo do aparelho." }],
    },
    {
      title: "Teste de reinício",
      noPointing: true,
      items: [
        {
          id: "d-reinicio",
          title: "Teste de reinício",
          details: "Testar o aparelho por 5 minutos para garantir que ele não reinicia.",
        },
      ],
    },
  ]),
];
