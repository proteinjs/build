import * as readline from 'readline-sync';
import { Conversation } from './Conversation';
import { KeywordToFilesIndexModuleFactory } from './fs/keyword_to_files_index/KeywordToFilesIndexModule';
import { ConversationTemplateModuleFactory } from './template/ConversationTemplateModule';
import { ConversationFsModuleFactory } from './fs/conversation_fs/ConversationFsModule';
import { PackageModuleFactory } from './fs/package/PackageModule';
import { ConversationModule, ConversationModuleFactory } from './ConversationModule';

export class CodegenConversation {
  private static INITIAL_QUESTION = 'What would you like to create?';
  private static BOT_NAME = 'Alina';
  private static MODEL = 'gpt-4';
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async start() {
    const conversation = await this.createConversation();
    conversation.addAssistantMessagesToHistory([CodegenConversation.INITIAL_QUESTION]);
    const initialUserInput = this.respondToUser(CodegenConversation.INITIAL_QUESTION);
    let response = await conversation.generateResponse([initialUserInput], CodegenConversation.MODEL);
    while (true) {
      const userInput = this.respondToUser(response);
      response = await conversation.generateResponse([userInput], CodegenConversation.MODEL);
    }
  }

  private async createConversation() {
    const conversation = new Conversation({
      name: this.constructor.name,
      modules: await this.getModules(),
      logLevel: 'info',
    });
    conversation.addSystemMessagesToHistory(this.getSystemMessages());
    return conversation;
  }

  private async getModules(): Promise<ConversationModule[]> {
    const moduleFactories: ConversationModuleFactory[] = [
      new ConversationFsModuleFactory(),
      new KeywordToFilesIndexModuleFactory(),
      new PackageModuleFactory(),
      new ConversationTemplateModuleFactory(),
    ];
    const modules: ConversationModule[] = [];
    for (let moduleFactory of moduleFactories)
      modules.push(await moduleFactory.createModule(this.repoPath));

    return modules;
  }

  private getSystemMessages() {
    return [
      `We are going to have a conversation with the user to generate code`,
      `Await all function calls that return a promise`,
      `If the user wants to generate code, identify files that may contain libraries to use from this repo, and access either their content or their typescript declarations via the available functions, whichever is needed for code generation`,
      `If using one of the repo apis, import the api from its corresponding package when generating code that uses that api`,
    ];
  }

  private respondToUser(message: string) {
    return readline.question(`[${CodegenConversation.BOT_NAME}] ${message}\n`);
  }
}