// Preferências por navegador. localStorage pode lançar exceção (aba privada,
// dados bloqueados), então toda leitura e escrita é protegida.

const CURRENT_DEVICE_KEY = "checklist-iphone-atual";
const LAST_TECH_KEY = "checklist-iphone-tec";

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sem armazenamento: segue sem lembrar */
  }
}

export const preferences = {
  getCurrentDeviceId: () => read(CURRENT_DEVICE_KEY),
  setCurrentDeviceId: (id: string) => write(CURRENT_DEVICE_KEY, id),
  getLastTech: () => read(LAST_TECH_KEY),
  setLastTech: (tec: string) => {
    if (tec) write(LAST_TECH_KEY, tec);
  },
};
