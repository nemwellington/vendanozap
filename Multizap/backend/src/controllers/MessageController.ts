import { Request, Response } from "express";
import AppError from "../errors/AppError";
import fs from "fs";
import GetTicketWbot from "../helpers/GetTicketWbot";
import SetTicketMessagesAsRead from "../helpers/SetTicketMessagesAsRead";
import { getIO } from "../libs/socket";
import Message from "../models/Message";
import Ticket from "../models/Ticket";
import Queue from "../models/Queue";
import User from "../models/User";
import Whatsapp from "../models/Whatsapp";
import path from "path";
import { isNil } from "lodash";
import { Mutex } from "async-mutex";

import ListMessagesService from "../services/MessageServices/ListMessagesService";
import ShowTicketService from "../services/TicketServices/ShowTicketService";
import DeleteWhatsAppMessage from "../services/WbotServices/DeleteWhatsAppMessage";
import SendWhatsAppMedia from "../services/WbotServices/SendWhatsAppMedia";
import SendWhatsAppMessage from "../services/WbotServices/SendWhatsAppMessage";
import CreateMessageService from "../services/MessageServices/CreateMessageService";
import { sendFacebookMessageMedia } from "../services/FacebookServices/sendFacebookMessageMedia";
import sendFaceMessage from "../services/FacebookServices/sendFacebookMessage";
import ShowPlanCompanyService from "../services/CompanyService/ShowPlanCompanyService";
import ListMessagesServiceAll from "../services/MessageServices/ListMessagesServiceAll";
import ShowContactService from "../services/ContactServices/ShowContactService";
import FindOrCreateTicketService from "../services/TicketServices/FindOrCreateTicketService";
import Contact from "../models/Contact";
import UpdateTicketService from "../services/TicketServices/UpdateTicketService";
import CompaniesSettings from "../models/CompaniesSettings";
import { verifyMessageFace, verifyMessageMedia } from "../services/FacebookServices/facebookMessageListener";
import EditWhatsAppMessage from "../services/MessageServices/EditWhatsAppMessage";
import CheckContactNumber from "../services/WbotServices/CheckNumber";
import { generateWAMessageFromContent, generateWAMessageContent, proto } from "@whiskeysockets/baileys";
import SendWhatsAppReaction from "../services/WbotServices/SendWhatsAppReaction";
import TranscribeAudioMessageToText from "../services/MessageServices/TranscribeAudioMessageService";
import ShowMessageService, { GetWhatsAppFromMessage } from "../services/MessageServices/ShowMessageService";

type IndexQuery = {
  pageNumber: string;
  ticketTrakingId: string;
  selectedQueues?: string;
};

interface TokenPayload {
  id: string;
  username: string;
  profile: string;
  companyId: number;
  iat: number;
  exp: number;
}

type MessageData = {
  body: string;
  fromMe: boolean;
  read: boolean;
  quotedMsg?: Message;
  number?: string;
  isPrivate?: string;
  vCard?: Contact;
};

// Função utilitária para extrair o campo body de mensagens
const extractMessageBody = (msg: any, fallback: string = "Mensagem interativa"): string => {
  if (msg.message?.interactiveMessage?.body?.text) {
    return msg.message.interactiveMessage.body.text;
  }
  if (msg.message?.listMessage?.description) {
    return msg.message.listMessage.description;
  }
  if (msg.message?.interactiveMessage?.nativeFlowMessage?.buttons[0]?.buttonParamsJson) {
    try {
      const params = JSON.parse(msg.message.interactiveMessage.nativeFlowMessage.buttons[0].buttonParamsJson);
      return params.order?.items[0]?.name || params.display_text || fallback;
    } catch {
      return fallback;
    }
  }
  return msg.message?.conversation || fallback;
};

// Função para gerar IDs únicos
const generateRandomCode = (length: number = 11): string => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length);
    code += characters[randomIndex];
  }
  return code;
};

// Adicionar reação
export const addReaction = async (req: Request, res: Response): Promise<Response> => {
  try {
    const { messageId } = req.params;
    const { type } = req.body;
    const { companyId, id } = req.user;

    const message = await Message.findByPk(messageId);
    if (!message) {
      throw new AppError("Mensagem não encontrada", 404);
    }

    const ticket = await Ticket.findByPk(message.ticketId, { include: ["contact"] });
    if (!ticket) {
      throw new AppError("Ticket não encontrado", 404);
    }

    const reactionResult = await SendWhatsAppReaction({
      messageId,
      ticket,
      reactionType: type,
    });

    const io = getIO();
    io.to(message.ticketId.toString()).emit(`company-${companyId}-appMessage`, {
      action: "update",
      message,
    });

    return res.status(200).json({
      message: "Reação adicionada com sucesso!",
      reactionResult,
    });
  } catch (error) {
    console.error("Erro ao adicionar reação:", error);
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return res.status(500).json({ message: "Erro ao adicionar reação", error: String(error) });
  }
};

// Enviar mensagem de lista
export const sendListMessage = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { title, text, buttonText, footer, sections } = req.body;

  try {
    const ticket = await Ticket.findByPk(ticketId);
    if (!ticket) {
      throw new AppError("Ticket not found", 404);
    }

    const contact = await Contact.findByPk(ticket.contactId);
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }

    const whatsapp = await Whatsapp.findOne({ where: { id: ticket.whatsappId } });
    if (!whatsapp || !whatsapp.number) {
      throw new AppError("Número de WhatsApp não encontrado", 404);
    }

    const number = `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
    const botNumber = whatsapp.number;
    const wbot = await GetTicketWbot(ticket);

    // Validate input
    if (!sections || !Array.isArray(sections) || sections.length === 0) {
      throw new AppError("Sections must be a non-empty array", 400);
    }
    if (!sections.every((section: any) => Array.isArray(section.rows) && section.rows.length > 0)) {
      throw new AppError("Each section must have at least one row", 400);
    }

    // Format sections for Baileys MD
    const formattedSections = sections.map((section: any) => ({
      title: section.title || "Section",
      rows: section.rows.map((row: any) => ({
        rowId: row.id || generateRandomCode(10),
        title: row.title || "Option",
        description: row.description || "",
      })),
    }));

    const listMessage: proto.IMessage = {
      listMessage: {
        title: title || "Lista de Opções",
        description: text || "Selecione uma opção",
        buttonText: buttonText || "Selecionar",
        footerText: footer || "",
        sections: formattedSections,
        listType: 1, // Single-select list
      },
    };

    console.debug("Sending list message:", JSON.stringify(listMessage, null, 2));

    // Ensure timestamp is a number
    const timestamp = Number(Math.round(Date.now() / 1000));
    console.debug("Timestamp:", timestamp);

    const newMsg = generateWAMessageFromContent(number, listMessage, {
      userJid: botNumber,
      
    });

    await wbot.relayMessage(number, newMsg.message, { messageId: newMsg.key.id! });

    // Preencher o campo body para salvar no banco
    const messageBody = text || title || "Lista interativa";
    const messageData = {
      wid: newMsg.key.id,
      ticketId: ticket.id,
      body: messageBody,
      fromMe: true,
      mediaType: "listMessage",
      read: true,
      ack: 1,
      remoteJid: number,
      participant: ticket.isGroup ? contact.number : "",
      dataJson: JSON.stringify(newMsg),
      ticketTrakingId: ticket.ticketTrakingId,
      companyId: ticket.companyId,
      isPrivate: false,
      isEdited: false,
      isForwarded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await CreateMessageService({ messageData, companyId: ticket.companyId });

    return res.status(200).json({ message: "List message sent successfully", newMsg });
  } catch (err) {
    console.error("Error sending list message:", err);
    throw new AppError(`Error sending list message: ${err.message}`, 500);
  }
};

// Enviar mensagem de cópia
export const sendCopyMessage = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { title, description, buttonText, copyText } = req.body;

  try {
    const ticket = await Ticket.findByPk(ticketId);
    if (!ticket) {
      throw new AppError("Ticket not found", 404);
    }
    const contact = await Contact.findByPk(ticket.contactId);
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }
    const whatsapp = await Whatsapp.findOne({ where: { id: ticket.whatsappId } });
    if (!whatsapp || !whatsapp.number) {
      throw new AppError("Número de WhatsApp não encontrado", 404);
    }

    const botNumber = whatsapp.number;
    const wbot = await GetTicketWbot(ticket);
    const copyMessage = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: title || "Botão copiar",
            },
            footer: {
              text: description || "Botão copiar",
            },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "cta_copy",
                  buttonParamsJson: JSON.stringify({
                    display_text: buttonText || "Botão copiar",
                    copy_code: copyText || "Botão copiar",
                  }),
                },
              ],
            },
          },
        },
      },
    };

    const number = `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
    const newMsg = generateWAMessageFromContent(number, copyMessage, { userJid: botNumber });
    await wbot.relayMessage(number, newMsg.message, { messageId: newMsg.key.id! });

    // Preencher o campo body para salvar no banco
    const messageBody = title || "Mensagem de cópia interativa";
    const messageData = {
      wid: newMsg.key.id,
      ticketId: ticket.id,
      body: messageBody,
      fromMe: true,
      mediaType: "viewOnceMessage",
      read: true,
      ack: 1,
      remoteJid: number,
      participant: ticket.isGroup ? contact.number : "",
      dataJson: JSON.stringify(newMsg),
      ticketTrakingId: ticket.ticketTrakingId,
      companyId: ticket.companyId,
      isPrivate: false,
      isEdited: false,
      isForwarded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await CreateMessageService({ messageData, companyId: ticket.companyId });

    return res.status(200).json({ message: "Copy message sent successfully", newMsg });
  } catch (error) {
    console.error("Erro ao enviar a mensagem de cópia:", error);
    throw new AppError("Error sending copy message", 500);
  }
};

// Enviar mensagem de chamada
export const sendCALLMessage = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { title, description, buttonText, copyText } = req.body;

  try {
    const ticket = await Ticket.findByPk(ticketId);
    if (!ticket) {
      throw new AppError("Ticket not found", 404);
    }
    const contact = await Contact.findByPk(ticket.contactId);
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }
    const whatsapp = await Whatsapp.findOne({ where: { id: ticket.whatsappId } });
    if (!whatsapp || !whatsapp.number) {
      throw new AppError("Número de WhatsApp não encontrado", 404);
    }

    const botNumber = whatsapp.number;
    const wbot = await GetTicketWbot(ticket);
    const callMessage = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: title || "Botão de chamada",
            },
            footer: {
              text: description || "Botão de chamada",
            },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "cta_call",
                  buttonParamsJson: JSON.stringify({
                    display_text: buttonText || "Botão de chamada",
                    phone_number: copyText || "Botão de chamada",
                  }),
                },
              ],
            },
          },
        },
      },
    };

    const number = `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
    const newMsg = generateWAMessageFromContent(number, callMessage, { userJid: botNumber });
    await wbot.relayMessage(number, newMsg.message, { messageId: newMsg.key.id! });

    // Preencher o campo body para salvar no banco
    const messageBody = title || "Mensagem de chamada interativa";
    const messageData = {
      wid: newMsg.key.id,
      ticketId: ticket.id,
      body: messageBody,
      fromMe: true,
      mediaType: "viewOnceMessage",
      read: true,
      ack: 1,
      remoteJid: number,
      participant: ticket.isGroup ? contact.number : "",
      dataJson: JSON.stringify(newMsg),
      ticketTrakingId: ticket.ticketTrakingId,
      companyId: ticket.companyId,
      isPrivate: false,
      isEdited: false,
      isForwarded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await CreateMessageService({ messageData, companyId: ticket.companyId });

    return res.status(200).json({ message: "Call message sent successfully", newMsg });
  } catch (error) {
    console.error("Erro ao enviar a mensagem de chamada:", error);
    throw new AppError("Error sending call message", 500);
  }
};

// Enviar mensagem de URL
export const sendURLMessage = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { image, title, description, buttonText, copyText } = req.body;

  try {
    const ticket = await Ticket.findByPk(ticketId);
    if (!ticket) {
      throw new AppError("Ticket not found", 404);
    }
    const contact = await Contact.findByPk(ticket.contactId);
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }
    const whatsapp = await Whatsapp.findOne({ where: { id: ticket.whatsappId } });
    if (!whatsapp || !whatsapp.number) {
      throw new AppError("Número de WhatsApp não encontrado", 404);
    }

    const botNumber = whatsapp.number;
    const wbot = await GetTicketWbot(ticket);
    let urlMessage: proto.IMessage;

    if (image) {
      if (!image.includes("base64,")) {
        throw new AppError("Invalid base64 image format", 400);
      }
      const base64Image = image.split(",")[1];
      const imageMessageContent = await generateWAMessageContent(
        {
          image: {
            url: `data:image/png;base64,${base64Image}`,
          },
        },
        { upload: wbot.waUploadToServer! }
      );

      urlMessage = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              body: {
                text: title || "Botão URL",
              },
              footer: {
                text: description || "Botão URL",
              },
              header: {
                imageMessage: imageMessageContent.imageMessage,
                hasMediaAttachment: true,
              },
              nativeFlowMessage: {
                buttons: [
                  {
                    name: "cta_url",
                    buttonParamsJson: JSON.stringify({
                      display_text: buttonText || "Botão URL",
                      url: copyText || "https://example.com",
                    }),
                  },
                ],
              },
            },
          },
        },
      };
    } else {
      urlMessage = {
        viewOnceMessage: {
          message: {
            interactiveMessage: {
              body: {
                text: title || "Botão URL",
              },
              footer: {
                text: description || "Botão URL",
              },
              nativeFlowMessage: {
                buttons: [
                  {
                    name: "cta_url",
                    buttonParamsJson: JSON.stringify({
                      display_text: buttonText || "Botão URL",
                      url: copyText || "https://example.com",
                    }),
                  },
                ],
              },
            },
          },
        },
      };
    }

    const number = `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
    const newMsg = generateWAMessageFromContent(number, urlMessage, { userJid: botNumber });
    await wbot.relayMessage(number, newMsg.message, { messageId: newMsg.key.id! });

    // Preencher o campo body para salvar no banco
    const messageBody = title || "Mensagem URL interativa";
    const messageData = {
      wid: newMsg.key.id,
      ticketId: ticket.id,
      body: messageBody,
      fromMe: true,
      mediaType: "viewOnceMessage",
      read: true,
      ack: 1,
      remoteJid: number,
      participant: ticket.isGroup ? contact.number : "",
      dataJson: JSON.stringify(newMsg),
      ticketTrakingId: ticket.ticketTrakingId,
      companyId: ticket.companyId,
      isPrivate: false,
      isEdited: false,
      isForwarded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await CreateMessageService({ messageData, companyId: ticket.companyId });

    return res.status(200).json({ message: "URL message sent successfully", newMsg });
  } catch (error) {
    console.error("Erro ao enviar a mensagem URL:", error);
    throw new AppError("Error sending URL message", 500);
  }
};

// Enviar mensagem PIX
// Enviar mensagem PIX
export const sendPIXMessage = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const {
    title,
    description,
    copyButtonText,
    sendKey,
  }: {
    title: string;
    description?: string;
    copyButtonText?: string;
    sendKey: string;
  } = req.body;

  try {
    const ticket = await Ticket.findByPk(ticketId);
    if (!ticket) {
      throw new AppError("Ticket not found", 404);
    }

    const contact = await Contact.findByPk(ticket.contactId);
    if (!contact) {
      throw new AppError("Contact not found", 404);
    }

    const whatsapp = await Whatsapp.findOne({ where: { id: ticket.whatsappId } });
    if (!whatsapp || !whatsapp.number) {
      throw new AppError("Número de WhatsApp não encontrado", 404);
    }

    // Validate input
    if (!sendKey || !title) {
      throw new AppError("Title and PIX key are required", 400);
    }

    // Validate PIX key format
    const validatePixKey = (key: string): boolean => {
      return (
        /^\+55\d{10,11}$/.test(key) || // PHONE
        /^\d{11}$/.test(key) || // CPF
        /^\d{14}$/.test(key) || // CNPJ
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) || // EMAIL
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(key) // EVP
      );
    };

    if (!validatePixKey(sendKey)) {
      throw new AppError("Invalid PIX key format", 400);
    }

    const number = `${contact.number}@${ticket.isGroup ? "g.us" : "s.whatsapp.net"}`;
    const botNumber = whatsapp.number;
    const wbot = await GetTicketWbot(ticket);

    const interactiveMsg = {
      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: {
              text: title || "Copiar Chave PIX",
            },
            footer: {
              text: description || "Clique para copiar a chave PIX",
            },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "cta_copy",
                  buttonParamsJson: JSON.stringify({
                    display_text: copyButtonText || "Copiar Chave PIX",
                    copy_code: sendKey,
                  }),
                },
              ],
            },
          },
        },
      },
    };

    const newMsg = generateWAMessageFromContent(number, interactiveMsg, { userJid: botNumber });
    await wbot.relayMessage(number, newMsg.message, { messageId: newMsg.key.id! });

    // Preencher o campo body para salvar no banco
    const messageBody = title || "Mensagem PIX interativa";
    const messageData = {
      wid: newMsg.key.id,
      ticketId: ticket.id,
      body: messageBody,
      fromMe: true,
      mediaType: "viewOnceMessage",
      read: true,
      ack: 1,
      remoteJid: number,
      participant: ticket.isGroup ? contact.number : "",
      dataJson: JSON.stringify(newMsg),
      ticketTrakingId: ticket.ticketTrakingId,
      companyId: ticket.companyId,
      isPrivate: false,
      isEdited: false,
      isForwarded: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await CreateMessageService({ messageData, companyId: ticket.companyId });

    return res.status(200).json({ message: "Mensagem enviada com sucesso", newMsg });
  } catch (error) {
    console.error("Erro ao enviar a mensagem PIX:", error);
    if (error instanceof AppError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    return res.status(500).json({ message: "Erro interno ao enviar a mensagem PIX", error: String(error) });
  }
};
// Transcrição de áudio

export const transcribeAudioMessage = async (req: Request, res: Response): Promise<Response> => {
  const { fileName } = req.params;
  const { companyId } = req.user;

  // Validação de entrada
  if (!fileName || typeof fileName !== 'string') {
    return res.status(400).json({ error: "fileName é obrigatório e deve ser uma string." });
  }
  if (!companyId || typeof companyId !== 'number') {
    return res.status(400).json({ error: "companyId é obrigatório e deve ser um número." });
  }

  try {
    // Criar uma instância da classe TranscribeAudioMessageToText
    const transcribeService = new TranscribeAudioMessageToText();
    
    // Chamar o método execute na instância
    const transcribedText = await transcribeService.execute(fileName, companyId);

    // Resposta bem-sucedida
    return res.json({ transcribedText });
  } catch (error) {
    console.error(`Erro ao transcrever a mensagem de áudio: ${error}`);
    return res.status(500).json({ error: "Erro ao transcrever a mensagem de áudio." });
  }
};

// Listar mensagens
export const index = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { pageNumber, selectedQueues: queueIdsStringified } = req.query as IndexQuery;
  const { companyId } = req.user;
  let queues: number[] = [];

  const user = await User.findByPk(req.user.id, {
    include: [{ model: Queue, as: "queues" }],
  });

  if (queueIdsStringified) {
    queues = JSON.parse(queueIdsStringified);
  } else {
    user!.queues.forEach((queue) => {
      queues.push(queue.id);
    });
  }

  const { count, messages, ticket, hasMore } = await ListMessagesService({
    pageNumber,
    ticketId,
    companyId,
    queues,
    user: user!,
  });

  if (ticket.channel === "whatsapp" && ticket.whatsappId) {
    await SetTicketMessagesAsRead(ticket);
  }

  return res.json({ count, messages, ticket, hasMore });
};

// Função para obter nome e extensão do arquivo
function obterNomeEExtensaoDoArquivo(url: string): string {
  const urlObj = new URL(url);
  const pathname = urlObj.pathname;
  const filename = pathname.split("/").pop() || "";
  const parts = filename.split(".");

  const nomeDoArquivo = parts[0];
  const extensao = parts[1] || "";

  return `${nomeDoArquivo}.${extensao}`;
}

// Armazenar mensagem
export const store = async (req: Request, res: Response): Promise<Response> => {
  const { ticketId } = req.params;
  const { body, quotedMsg, vCard, isPrivate = "false" }: MessageData = req.body;
  const medias = req.files as Express.Multer.File[];
  const { companyId } = req.user;

  const ticket = await ShowTicketService(ticketId, companyId);

  if (ticket.channel === "whatsapp" && ticket.whatsappId) {
    await SetTicketMessagesAsRead(ticket);
  }

  try {
    if (medias) {
      await Promise.all(
        medias.map(async (media: Express.Multer.File, index) => {
          if (ticket.channel === "whatsapp") {
            await SendWhatsAppMedia({
              media,
              ticket,
              body: Array.isArray(body) ? body[index] : body,
              isPrivate: isPrivate === "true",
              isForwarded: false,
            });
          }

          if (["facebook", "instagram"].includes(ticket.channel)) {
            try {
              const sentMedia = await sendFacebookMessageMedia({
                media,
                ticket,
                body: Array.isArray(body) ? body[index] : body,
              });

              if (ticket.channel === "facebook") {
                await verifyMessageMedia(sentMedia, ticket, ticket.contact, true);
              }
            } catch (error) {
              console.error("Erro ao enviar mídia para Facebook/Instagram:", error);
            }
          }

          const filePath = path.resolve("public", `company${companyId}`, media.filename);
          if (fs.existsSync(filePath) && isPrivate === "false") {
            fs.unlinkSync(filePath);
          }
        })
      );
    } else {
      if (ticket.channel === "whatsapp" && isPrivate === "false") {
        await SendWhatsAppMessage({ body, ticket, quotedMsg, vCard });
      } else if (ticket.channel === "whatsapp" && isPrivate === "true") {
        const messageData = {
          wid: `PVT${ticket.updatedAt.toString().replace(" ", "")}`,
          ticketId: ticket.id,
          contactId: undefined,
          body,
          fromMe: true,
          mediaType: !isNil(vCard) ? "contactMessage" : "extendedTextMessage",
          read: true,
          quotedMsgId: null,
          ack: 2,
          remoteJid: ticket.contact?.remoteJid,
          participant: null,
          dataJson: null,
          ticketTrakingId: null,
          isPrivate: isPrivate === "true",
          companyId: ticket.companyId,
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        await CreateMessageService({ messageData, companyId: ticket.companyId });
      } else if (["facebook", "instagram"].includes(ticket.channel)) {
        const sendText = await sendFaceMessage({ body, ticket, quotedMsg });

        if (ticket.channel === "facebook") {
          await verifyMessageFace(sendText, body, ticket, ticket.contact, true);
        }
      }
    }
    return res.status(200).json({ message: "Mensagem enviada com sucesso" });
  } catch (error) {
    console.error("Erro ao armazenar mensagem:", error);
    return res.status(400).json({ error: error.message });
  }
};

// Encaminhar mensagem
export const forwardMessage = async (req: Request, res: Response): Promise<Response> => {
  const { quotedMsg, signMessage, messageId, contactId } = req.body;
  const { id: userId, companyId } = req.user;
  const requestUser = await User.findByPk(userId);

  if (!messageId || !contactId) {
    return res.status(400).json({ message: "MessageId or ContactId not found" });
  }
  const message = await ShowMessageService(messageId);
  const contact = await ShowContactService(contactId, companyId);

  if (!message) {
    return res.status(404).json({ message: "Message not found" });
  }
  if (!contact) {
    return res.status(404).json({ message: "Contact not found" });
  }

  const settings = await CompaniesSettings.findOne({ where: { companyId } });

  const whatsAppConnectionId = await GetWhatsAppFromMessage(message);
  if (!whatsAppConnectionId) {
    return res.status(404).json({ message: "Whatsapp from message not found" });
  }

  const ticket = await ShowTicketService(message.ticketId, message.companyId);

  const mutex = new Mutex();

  const createTicket = await mutex.runExclusive(async () => {
    const result = await FindOrCreateTicketService(
      contact,
      ticket?.whatsapp,
      0,
      ticket.companyId,
      ticket.queueId,
      requestUser!.id,
      contact.isGroup ? contact : null,
      "whatsapp",
      null,
      true,
      settings,
      false,
      false
    );

    return result;
  });

  let ticketData;

  if (isNil(createTicket?.queueId)) {
    ticketData = {
      status: createTicket.isGroup ? "group" : "open",
      userId: requestUser!.id,
      queueId: ticket.queueId,
    };
  } else {
    ticketData = {
      status: createTicket.isGroup ? "group" : "open",
      userId: requestUser!.id,
    };
  }

  await UpdateTicketService({
    ticketData,
    ticketId: createTicket.id,
    companyId: createTicket.companyId,
  });

  let body = message.body;
  if (message.mediaType === "conversation" || message.mediaType === "extendedTextMessage") {
    await SendWhatsAppMessage({ body, ticket: createTicket, quotedMsg, isForwarded: !message.fromMe });
  } else {
    const mediaUrl = message.mediaUrl.replace(`:${process.env.PORT}`, "");
    const fileName = obterNomeEExtensaoDoArquivo(mediaUrl);

    if (body === fileName) {
      body = "";
    }

    const publicFolder = path.join(__dirname, "..", "..", "..", "backend", "public");
    const filePath = path.join(publicFolder, `company${createTicket.companyId}`, fileName);

    const mediaSrc = {
      fieldname: "medias",
      originalname: fileName,
      encoding: "7bit",
      mimetype: message.mediaType,
      filename: fileName,
      path: filePath,
    } as Express.Multer.File;

    await SendWhatsAppMedia({ media: mediaSrc, ticket: createTicket, body, isForwarded: !message.fromMe });
  }

  return res.status(200).json({ message: "Mensagem encaminhada com sucesso" });
};

// Remover mensagem
export const remove = async (req: Request, res: Response): Promise<Response> => {
  const { messageId } = req.params;
  const { companyId } = req.user;

  const message = await DeleteWhatsAppMessage(messageId, companyId);
  const io = getIO();

  if (message.isPrivate) {
    await Message.destroy({ where: { id: message.id } });
    io.of(String(companyId)).emit(`company-${companyId}-appMessage`, {
      action: "delete",
      message,
    });
  }

  io.of(String(companyId)).emit(`company-${companyId}-appMessage`, {
    action: "update",
    message,
  });

  return res.status(200).json({ message: "Mensagem removida com sucesso" });
};

// Contar mensagens
export const allMe = async (req: Request, res: Response): Promise<Response> => {
  const dateStart: any = req.query.dateStart;
  const dateEnd: any = req.query.dateEnd;
  const fromMe: any = req.query.fromMe;
  const { companyId } = req.user;

  const { count } = await ListMessagesServiceAll({
    companyId,
    fromMe,
    dateStart,
    dateEnd,
  });

  return res.json({ count });
};

// Enviar mensagem
export const send = async (req: Request, res: Response): Promise<Response> => {
  const messageData: MessageData = req.body;
  const medias = req.files as Express.Multer.File[];

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new AppError("Token de autorização não fornecido", 401);
    }

    const [, token] = authHeader.split(" ");
    const whatsapp = await Whatsapp.findOne({ where: { token } });
    if (!whatsapp) {
      throw new AppError("Não foi possível realizar a operação", 404);
    }

    const companyId = whatsapp.companyId;
    const company = await ShowPlanCompanyService(companyId);
    const sendMessageWithExternalApi = company.plan.useExternalApi;

    if (!sendMessageWithExternalApi) {
      throw new AppError(
        "Essa empresa não tem permissão para usar a API Externa. Entre em contato com o Suporte para verificar nossos planos!",
        403
      );
    }

    if (messageData.number === undefined) {
      throw new AppError("O número é obrigatório", 400);
    }

    const number = messageData.number;
    const body = messageData.body;

    if (medias) {
      await Promise.all(
        medias.map(async (media: Express.Multer.File) => {
          await req.app.get("queues").messageQueue.add(
            "SendMessage",
            {
              whatsappId: whatsapp.id,
              data: {
                number,
                body: media.originalname.replace("/", "-"),
                mediaPath: media.path,
              },
            },
            { removeOnComplete: true, attempts: 3 }
          );
        })
      );
    } else {
      await req.app.get("queues").messageQueue.add(
        "SendMessage",
        {
          whatsappId: whatsapp.id,
          data: {
            number,
            body,
          },
        },
        { removeOnComplete: true, attempts: 3 }
      );
    }
    return res.status(200).json({ mensagem: "Mensagem enviada!" });
  } catch (err) {
    console.error("Erro ao enviar mensagem:", err);
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({ message: err.message });
    }
    throw new AppError("Não foi possível enviar a mensagem, tente novamente em alguns instantes", 500);
  }
};

// Editar mensagem
export const edit = async (req: Request, res: Response): Promise<Response> => {
  const { messageId } = req.params;
  const { companyId } = req.user;
  const { body }: MessageData = req.body;

  try {
    const { ticket, message } = await EditWhatsAppMessage({ messageId, body });

    const io = getIO();
    io.of(String(companyId)).emit(`company-${companyId}-appMessage`, {
      action: "update",
      message,
    });

    io.of(String(companyId)).emit(`company-${companyId}-ticket`, {
      action: "update",
      ticket,
    });

    return res.status(200).json({ message: "Mensagem editada com sucesso" });
  } catch (error) {
    console.error("Erro ao editar mensagem:", error);
    throw new AppError("Erro ao editar mensagem", 500);
  }
};

// Enviar mensagem em fluxo
export const sendMessageFlow = async (
  whatsappId: number,
  body: any,
  req: Request,
  files?: Express.Multer.File[]
): Promise<string> => {
  const messageData = body;
  const medias = files;

  try {
    const whatsapp = await Whatsapp.findByPk(whatsappId);
    if (!whatsapp) {
      throw new AppError("Não foi possível realizar a operação", 404);
    }

    if (messageData.number === undefined) {
      throw new AppError("O número é obrigatório", 400);
    }

    const numberToTest = messageData.number;
    const body = messageData.body;
    const companyId = messageData.companyId;

    const CheckValidNumber = await CheckContactNumber(numberToTest, companyId);
    const number = CheckValidNumber.replace(/\D/g, "");

    if (medias) {
      await Promise.all(
        medias.map(async (media: Express.Multer.File) => {
          await req.app.get("queues").messageQueue.add(
            "SendMessage",
            {
              whatsappId,
              data: {
                number,
                body: media.originalname,
                mediaPath: media.path,
              },
            },
            { removeOnComplete: true, attempts: 3 }
          );
        })
      );
    } else {
      await req.app.get("queues").messageQueue.add(
        "SendMessage",
        {
          whatsappId,
          data: {
            number,
            body,
          },
        },
        { removeOnComplete: false, attempts: 3 }
      );
    }

    return "Mensagem enviada";
  } catch (err) {
    console.error("Erro ao enviar mensagem no fluxo:", err);
    if (err instanceof AppError) {
      throw err;
    }
    throw new AppError("Não foi possível enviar a mensagem, tente novamente em alguns instantes", 500);
  }
};