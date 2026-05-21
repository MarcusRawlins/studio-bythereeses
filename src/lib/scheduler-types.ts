export type InviteeQuestionType = "text" | "textarea" | "radio" | "checkbox" | "select";

export type InviteeQuestion = {
  id: string;
  label: string;
  type: InviteeQuestionType;
  required: boolean;
  options?: string[];
};
