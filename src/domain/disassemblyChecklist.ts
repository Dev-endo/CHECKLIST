import { buildCatalog, type ChecklistBlock } from "./checklist";

/** Desmontagem e desmontagem técnica: mesmos testes, com o aparelho aberto. */
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
