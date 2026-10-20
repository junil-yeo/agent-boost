// Which quit confirmation a team member gets (pure; renderer: agentactions.js quitDialog, tests: test/quitplan.test.js).
//
//  - an in-process teammate whose lead is live: a light confirmation — the lead stops it with the CLI's own x in its
//    agent panel, and a later message from the lead brings the conversation back;
//  - a tmux teammate, any teammate whose lead is not live: it cannot be joined to its lead again, so the person is asked
//    whether its results reached the lead ("팀장에게 보고 후 종료" asks for that first);
//  - a lead with live teammates: they end with it and do not come back on resume (the CLI does not restore teammates);
//  - anything else (a solo session, an ended member, a subagent): null — the ordinary quit dialog.
// Button values go to store.quitVia(sid, value): 'stop' (shut down through the lead), 'report' (report first, then shut
// down), 'now' (the lead itself, at once). The texts go through L(), installed with setL().
let tr = (s, ...a) => { let i = 0; return s.replace(/%@/g, () => String(a[i++])); };
export function setL(fn) { tr = fn; }

const live = (a) => !!a && a.state !== 'ended';
/** The team's lead in a board snapshot (null when the agent is not in a team). */
export function leadOf(agent, s) {
  if (!agent || agent.teamName == null) return null;
  const t = ((s && s.teams) || []).find((x) => x.name === agent.teamName);
  return t ? t.members.find((m) => m.isLead) || null : null;
}
/** A lead the app can type into (the requests go through its input box). */
export const leadControllable = (l) => live(l) && l.tmuxPane != null;

export function quitPlan(agent, s) {
  if (!agent || !live(agent) || agent.isSubagent || agent.teamName == null || agent.solo) return null;
  const t = ((s && s.teams) || []).find((x) => x.name === agent.teamName);
  if (agent.isLead) {
    const mates = t ? t.members.filter((m) => !m.isLead && !m.isSubagent && live(m)) : [];
    if (!mates.length) return null;
    return {
      kind: 'lead',
      title: tr("'%@' 종료", agent.name),
      message: tr('팀장을 종료하면 팀원 %@명도 함께 종료되며, 다시 시작해도 팀원은 돌아오지 않습니다.', String(mates.length)),
      buttons: leadControllable(agent)
        ? [{ label: tr('팀장에게 보고 후 종료'), value: 'report' }, { label: tr('그냥 종료'), role: 'destructive', value: 'now' }, { label: tr('취소'), role: 'cancel' }]
        : [{ label: tr('그냥 종료'), role: 'destructive', value: 'now' }, { label: tr('취소'), role: 'cancel' }],
    };
  }
  const lead = leadOf(agent, s);
  if (agent.inProcess && leadControllable(lead)) {
    return {
      kind: 'light',
      title: tr("'%@' 종료", agent.name),
      message: tr('팀장이 다시 메시지를 보내면 대화를 이어서 돌아옵니다.'),
      buttons: [{ label: tr('종료'), role: 'destructive', value: 'stop' }, { label: tr('취소'), role: 'cancel' }],
    };
  }
  // the report request needs someone to type it to: the live lead, else the teammate itself (it has a pane)
  const canReport = leadControllable(lead) || (agent.tmuxPane != null && !agent.inProcess);
  return {
    kind: 'heavy',
    title: tr("'%@' 종료", agent.name),
    message: tr('이 팀원은 다시 팀장과 연결할 수 없습니다. 필요한 결과를 팀장에게 보고했는지 확인하세요.'),
    buttons: [
      ...(canReport ? [{ label: tr('팀장에게 보고 후 종료'), value: 'report' }] : []),
      { label: tr('그냥 종료'), role: 'destructive', value: 'stop' },
      { label: tr('취소'), role: 'cancel' },
    ],
  };
}
