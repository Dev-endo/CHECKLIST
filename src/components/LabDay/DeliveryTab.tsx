import { useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { canUseLabDay } from "../../domain/roles";
import appStyles from "../../App.module.css";
import { AssignAssets } from "./AssignAssets";
import { RejectedBalloon } from "./RejectedBalloon";

/** Dia Laboratório > Entrega de ativos: o supervisor bipa os ativos, escolhe o técnico e vincula (um balão por ativo). */
export function DeliveryTab() {
  const { user, client } = useAuth();
  const [deliveries, setDeliveries] = useState(0);
  if (!client || !user) return <p className={appStyles.banner}>Entre com a sua conta para usar o Dia Laboratório.</p>;
  if (!canUseLabDay(user.roles)) return <p className={appStyles.banner}>Só supervisor e admin usam o Dia Laboratório.</p>;
  return (
    <>
      <header>
        <h1 className={appStyles.title}>Entrega de ativos</h1>
        <p className={appStyles.subtitle}>
          Bipe os ativos, escolha o técnico e vincule: cada ativo vira um balão no Checklist manutenção dele e entra na meta do dia. Ativo no
          Vidro é direcionado; reprovado na quarentena é redistribuído.
        </p>
      </header>
      <AssignAssets client={client} mode="entrega" onDone={() => setDeliveries((n) => n + 1)} />
      <RejectedBalloon client={client} reloadKey={deliveries} />
    </>
  );
}
