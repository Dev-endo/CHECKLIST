export interface ChecklistItem {
  id: string;
  title: string;
  /** Instrução do teste. */
  details?: string;
  /** Critério de reprovação, exibido em destaque. */
  failure?: string;
}

export interface ChecklistBlock {
  title: string;
  items: readonly ChecklistItem[];
}

export const CHECKLIST: readonly ChecklistBlock[] = [
  {
    title: "Tela e touch",
    items: [
      { id: "tela-branca", title: "Tela branca, brilho máximo", details: "Procurar manchas, pontos claros, amarelado ou sombra nas bordas." },
      { id: "tela-preta", title: "Tela preta", failure: "linha ou pixel aceso." },
      { id: "touch", title: "Arrastar um ícone pela tela toda", details: "Modo de edição, arrastar devagar por bordas, cantos e centro.", failure: "ícone solta sozinho." },
      { id: "teclado", title: "Digitar rápido no teclado", details: "Cobrir Q, P, espaço e apagar (extremidades)." },
      { id: "truetone", title: "True Tone e brilho automático", details: "True Tone aparece na Central de Controle; cobrir o topo baixa o brilho." },
    ],
  },
  {
    title: "Sensores e biometria",
    items: [
      { id: "prox", title: "Sensor de proximidade", details: "Em ligação ou áudio no ouvido, cobrir o topo: tela apaga e acende na hora." },
      { id: "faceid", title: "Face ID / Touch ID", details: "Iniciar o cadastro: a leitura começa sem erro de posição. Touch ID: cadastrar e desbloquear.", failure: "“Face ID indisponível”." },
    ],
  },
  {
    title: "Áudio e microfones",
    items: [
      { id: "auricular", title: "Auricular", details: "Ligação ou áudio no ouvido: som claro, sem chiado ou abafado." },
      { id: "altofalante", title: "Alto-falante", details: "Toque no volume máximo, sem distorção ou estalo." },
      { id: "mic-inf", title: "Microfone inferior", details: "Gravar no app Gravador e ouvir." },
      { id: "mic-tras", title: "Microfone traseiro", details: "Gravar vídeo com a câmera traseira falando atrás do aparelho." },
      { id: "mic-front", title: "Microfone frontal", details: "Gravar vídeo com a câmera frontal, a um braço de distância." },
    ],
  },
  {
    title: "Câmeras",
    items: [
      { id: "foco", title: "Câmera traseira: foco, estabilização e manchas", details: "Objeto a 10 cm e depois ao fundo, e apontar para parede branca.", failure: "foco lento, zumbido, imagem tremendo ou manchas fixas." },
      { id: "lentes", title: "Troca de lentes", details: "0,5x, 1x, 2x/3x e Retrato sem travar, piscar preto ou fechar o app." },
      { id: "frontal", title: "Câmera frontal", details: "Foto e vídeo com foco e sem manchas." },
      { id: "flash", title: "Flash e lanterna", details: "Lanterna acende contínua; flash dispara na foto." },
    ],
  },
  {
    title: "Conectividade e carga",
    items: [
      { id: "wifi", title: "Wi-Fi e Bluetooth", details: "Verificar se aparecem redes e dispositivos disponíveis." },
      { id: "carga", title: "Conector de carga", details: "Carregar com o cabo nas duas posições, sem mau contato." },
      { id: "sem-fio", title: "Carga sem fio (se o modelo tiver)", details: "Na base Qi/MagSafe a carga inicia na hora." },
    ],
  },
  {
    title: "Botões e vibração",
    items: [
      { id: "botoes", title: "Power, volume + e −, silencioso/Ação", details: "Clique firme e com retorno, sem botão afundado." },
      { id: "vibra", title: "Vibração", details: "Acionar o silencioso: vibração firme, sem ruído solto." },
    ],
  },
  {
    title: "Sistema",
    items: [
      { id: "bateria", title: "Saúde da bateria", details: "Ajustes › Bateria › Saúde: sem aviso de manutenção ou bateria desconhecida." },
      { id: "pecas", title: "Peças e histórico de serviço", details: "Ajustes › Geral › Sobre: mensagens de peça de acordo com o serviço feito." },
      { id: "panic", title: "Registros de travamento", details: "Ajustes › Privacidade e Segurança › Análise e Melhorias › Dados de Análise.", failure: "arquivo “panic-full” com a data de hoje." },
    ],
  },
];

export const ALL_ITEMS: readonly ChecklistItem[] = CHECKLIST.flatMap((block) => block.items);
