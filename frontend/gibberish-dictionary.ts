/* Gibberish dictionary: English words and their "Wenomechainsama"
 * spellings, from the pixels-spicy-lyrics fork's
 * src/utils/Lyrics/Gibberish/Dictionary.ts (iPixelGalaxy/spicy-lyrics
 * a60aa34, AGPL-3.0). The fork's 2,113 regex entries become one lookup
 * table; where a word was listed twice, its first spelling is kept, as
 * the fork applied it first. */
export const GIBBERISH_WORDS: ReadonlyMap<string, string> = new Map(
  (
    "i'm=am i'll=al i've=av i'd=ad you're=uar you'll=ual you've=uav " +
    "you'd=uad we're=wiar we'll=wial we've=wiav they're=dear " +
    "they'll=deal they've=deav he's=his she's=shis it's=es that's=das " +
    "what's=was there's=ders here's=hias let's=les don't=don can't=kan " +
    "won't=won isn't=isen aren't=aren didn't=diden doesn't=dusen " +
    "wasn't=wosen weren't=weren wouldn't=wuden couldn't=kuden " +
    "shouldn't=shuden haven't=haven hasn't=hasen ain't=en i=o me=mi " +
    "my=ma myself=masef mine=main you=u your=ua yours=uas " +
    "yourself=uasef we=wi our=awa ours=awas us=os he=hi him=hem his=hes " +
    "himself=hemsef she=shi her=ha hers=has herself=hasef it=et its=ets " +
    "itself=etsef they=de them=dem their=da theirs=das " +
    "themselves=demsef the=da this=dis that=da these=dis those=dos a=e " +
    "an=en is=es am=em are=ar was=wos were=wer been=bin being=bin be=bi " +
    "have=haf has=hes had=hed having=hafin do=du does=das did=ded " +
    "doing=duin done=dan will=wil would=wud shall=shal should=shud " +
    "can=ken could=kul may=me might=mai must=mas need=nid want=wan " +
    "wanted=waned wanting=wanin go=gu goes=gos going=goin gone=gon " +
    "went=wen get=ge gets=ges getting=getin got=go gotten=gotn come=kam " +
    "comes=kams coming=kamin came=kem make=mek makes=meks making=mekin " +
    "made=med take=tek takes=teks taking=tekin took=tuk taken=tekn " +
    "give=gif gives=gifs giving=gifin gave=gef given=gifn put=pu " +
    "puts=pus putting=puin let=le lets=les letting=lein keep=kip " +
    "keeps=kips keeping=kipin kept=kep try=tra tries=tras trying=train " +
    "tried=trad run=ran runs=rans running=ranin ran=ren turn=ter " +
    "turns=ters turning=terin turned=terd fall=fol falls=fols " +
    "falling=folin fell=fel fallen=foln hold=hol holds=hols " +
    "holding=holin held=hel wait=wet waits=wets waiting=wetin stop=sto " +
    "stops=stos stopping=stoin stopped=stod start=star starts=stars " +
    "starting=starin started=stard end=en ends=ens ending=enin " +
    "ended=end show=sho shows=shos showing=shoin showed=shod shown=shon " +
    "ask=as asks=ass asking=asin asked=asd use=yus uses=yuses " +
    "using=yusin used=yusd set=se sets=ses setting=sein act=ak acts=aks " +
    "acting=akin lay=le lays=les laying=lein laid=led lie=la lies=las " +
    "lying=lain lied=laid met=me see=si sees=sis seeing=siin saw=so " +
    "seen=sin look=luk looks=luks looking=lukin looked=lukd watch=woch " +
    "watching=wochin hear=hia hears=hias hearing=hiain heard=hiad " +
    "listen=lisn listening=lisnin tell=tel tells=tels telling=telin " +
    "told=tol say=se says=ses saying=sein said=sed speak=spik " +
    "speaking=spikin spoke=spok spoken=spokn talk=tok talks=toks " +
    "talking=tokin call=kol calls=kols calling=kolin called=kold " +
    "think=tink thinks=tinks thinking=tinkin thought=tot know=no " +
    "knows=nos knowing=noin knew=nu known=non feel=fil feels=fils " +
    "feeling=filin felt=fel believe=bilif believing=bilifin " +
    "believed=bilifd understand=andastan remember=rimemba forget=foge " +
    "forgot=fogo forgotten=fogotn move=muf moves=mufs moving=mufin " +
    "moved=mufd walk=wok walks=woks walking=wokin stand=stan " +
    "standing=stanin stood=stud sit=se sitting=sein sat=sa rise=rais " +
    "rising=raisin rose=ros risen=risn fly=fla flying=flain flew=flu " +
    "drive=draif driving=draifin drove=drof reach=rich reaching=richin " +
    "reached=richd leave=lif leaving=lifin left=lef stay=ste stays=stes " +
    "staying=stein stayed=sted follow=folo following=foloin " +
    "followed=folod lead=lid leading=lidin led=lad pull=pul " +
    "pulling=pulin push=pus pushing=pushin carry=kari carrying=kariin " +
    "carried=karid bring=brin bringing=brinin brought=brot send=sen " +
    "sending=senin sent=sen love=luf loves=lufs loving=lufin loved=lufd " +
    "hate=het hates=hets hating=hetin hated=hetd like=laik likes=laiks " +
    "liking=laikin liked=laikd miss=mis misses=mises missing=misin " +
    "missed=misd wish=wis wishes=wishs wishing=wishin hope=hop " +
    "hopes=hops hoping=hopin hoped=hopd dream=drim dreams=drims " +
    "dreaming=drimin cry=kra cries=kras crying=krain cried=krad " +
    "laugh=laf laughing=lafin laughed=lafd smile=smail smiling=smailin " +
    "smiled=smaild sing=sin sings=sins singing=sinin sang=san sung=san " +
    "dance=dans dances=danses dancing=dansin danced=dansd play=ple " +
    "plays=ples playing=plein played=pled fight=fai fighting=faiin " +
    "fought=fot kill=kil killing=kilin killed=kild die=dai dies=dais " +
    "dying=dain died=daid dead=ded live=lif lives=lifs living=lifin " +
    "alive=alaif burn=bern burning=bernin burned=bernd burnt=bern " +
    "shine=shain shining=shainin break=brek breaking=brekin broke=brok " +
    "broken=brokn fix=fiks fixing=fiksin fixed=fiksd build=bil " +
    "building=bilin built=bil create=krie creating=kriein " +
    "destroy=distro destroying=distroin destroyed=distrod open=opn " +
    "opening=opnin opened=opnd close=klos closing=klosin closed=klosd " +
    "find=faind finds=fainds finding=faindin found=faun lose=lus " +
    "losing=lusin lost=los choose=chus choosing=chusin chose=chos " +
    "chosen=chosn change=chen changing=chenin changed=chend grow=gro " +
    "growing=groin grew=gru grown=gron learn=lern learning=lernin " +
    "learned=lernd teach=tich teaching=tichin taught=tot read=rid " +
    "reading=ridin write=rai writing=rain wrote=rot written=ritn " +
    "draw=dro drawing=droin drew=dru drawn=dron pay=pe paying=pein " +
    "paid=ped buy=ba buying=bain bought=bot sell=sel selling=selin " +
    "sold=sol sleep=slip sleeping=slipin slept=slep wake=wek " +
    "waking=wekin woke=wok woken=wokn eat=it eating=itin ate=et " +
    "eaten=itn drink=drin drinking=drinin drank=dran drunk=dran hit=he " +
    "hitting=hein cut=ka cutting=kain pick=pik picking=pikin " +
    "picked=pikd wear=wea wearing=weain wore=wor worn=won help=hel " +
    "helps=hels helping=helin helped=held work=wok works=woks " +
    "working=wokin worked=wokd save=sef saving=sefin saved=sefd " +
    "wanna=wana gonna=gona gotta=gota in=en into=intu on=un at=a to=tu " +
    "for=fo from=fro of=ov with=wit without=witau by=ba up=ap out=au " +
    "off=of down=daun over=ova under=anda above=abuf below=bilo " +
    "between=bitwin behind=bihaind before=bifo after=afta about=abau " +
    "around=araun through=tru though=do although=oldo across=akros " +
    "along=alon against=agen toward=tuward towards=tuwards and=an " +
    "but=bu or=o if=ef so=su because=bikos since=sins until=antil " +
    "while=wail when=wen where=wea what=wa which=wich who=hu how=hau " +
    "why=wai then=den than=dan good=gu better=beta best=bes bad=ba " +
    "worse=wos worst=wos new=nyu old=ol big=bi small=smol tall=tol " +
    "short=shor long=lon longer=longa longest=longes high=hai " +
    "higher=haia highest=haies low=lo lower=loa fast=fas slow=slo " +
    "hard=ha soft=sof loud=lau quiet=kwaie hot=ho cold=kol warm=wom " +
    "cool=kul real=ril really=rili true=tru truly=truli full=ful " +
    "empty=emti rich=ric poor=pua strong=stron weak=wik happy=hapi " +
    "sad=sed angry=angri scary=skeri crazy=kresi safe=sef " +
    "dangerous=denjrus beautiful=byutifo ugly=ugli pretty=priti " +
    "handsome=hansam perfect=perfek wrong=ron right=rai ready=redi " +
    "free=fri busy=bisi easy=isi difficult=difikol simple=simpo " +
    "special=spesho important=impotan different=difren same=sem " +
    "other=ada next=nek last=las first=fers second=sekon only=onli " +
    "own=on every=evri each=ich both=bot all=ol many=meni much=mach " +
    "more=mo most=mos less=les least=lis few=fu enough=enaf late=let " +
    "early=erli soon=sun now=nau still=stil also=olso even=ifn too=tu " +
    "very=veri just=jas back=bak here=hia there=dea everywhere=evriwea " +
    "nowhere=nowea somewhere=samwea anywhere=eniwea always=olwes " +
    "never=neva sometimes=samtaims maybe=mebi probably=probli " +
    "actually=akchuli basically=besikli literally=litrali " +
    "finally=fainali already=olredi together=tuget apart=apa away=awe " +
    "inside=insaid outside=autsaid again=agen forever=foreva " +
    "innocent=inoce people=pipl person=persn man=men woman=wumen boy=bo " +
    "girl=gal child=chaild children=childrin baby=beby friend=fren " +
    "friends=frens brother=brada sister=sista mother=mada father=fada " +
    "family=famili heart=har heartbeat=jarbi hearts=hars mind=maind " +
    "soul=sol body=badi hand=han hands=hans head=hed face=fes eyes=ais " +
    "eye=ai lips=leps mouth=mau arms=ams arm=am blood=blad tears=tias " +
    "tear=tia voice=voys breath=bref skin=sken bone=bon bones=bons " +
    "world=wald earth=ert sky=ska skies=skys sun=san moon=mun star=sta " +
    "stars=stas light=lai lights=lais dark=dak darkness=daknes " +
    "shadow=shado shadows=shados fire=faia flame=flem flames=flems " +
    "water=wata rain=ren wind=win storm=stom snow=sno ice=ais " +
    "ocean=oshun sea=si wave=wef waves=wefs river=riva mountain=mauntn " +
    "ground=graun floor=flo tree=tri trees=tris flower=flawa " +
    "flowers=flawas leaf=lif leaves=lifs garden=gadn field=fild " +
    "forest=fores night=nai nights=nais day=de days=des morning=monin " +
    "evening=ifnin tonight=tunai today=tude tomorrow=tumoro " +
    "yesterday=yestade time=taim times=taims moment=momen minute=minu " +
    "hour=awa year=yia years=yias life=laif death=def power=pawa " +
    "energy=eneji peace=pis war=wo pain=pen joy=jo happiness=hapines " +
    "anger=anga fear=fia truth=trut freedom=fridom desire=disaia " +
    "faith=feit trust=tras promise=promis secret=sikre story=stori " +
    "stories=storis song=son songs=sons music=myuzik word=wod " +
    "words=wods name=nem names=nems place=ples places=pleses room=rum " +
    "house=haus home=hom door=do window=windo wall=wol walls=wols " +
    "road=rod street=strit city=siti country=kantri side=said part=pa " +
    "way=we ways=wes thing=tin things=tins everything=evrtin " +
    "something=samtin nothing=natin anything=enitin everyone=evrwan " +
    "someone=samwan anyone=eniwan nobody=nobadi everybody=evribadi " +
    "somebody=sambadi money=mani letter=leta phone=fon king=kin " +
    "queen=kwin prince=prins princess=prinses hero=hiro angel=enjl " +
    "devil=defl god=gad heaven=hefn hell=hel church=cherch drug=drag " +
    "drugs=drags gun=gan guns=gans car=ka clothes=klos shoes=shus " +
    "ring=rin chain=chen gold=gol diamonds=daimns diamond=daimn " +
    "crown=kraun throne=tron black=blak white=wai red=rad blue=blu " +
    "green=grin yellow=yelo golden=goldn brown=braun purple=perpo " +
    "pink=penk grey=gre gray=gre one=wan two=tu three=tri four=fo " +
    "five=faif six=siks seven=sefn eight=et nine=nain ten=tan " +
    "hundred=handrd thousand=tausn million=milyon half=haf not=no no=nu " +
    "yes=yas yeah=ye yep=yap nah=na nope=nop ok=oke okay=oke oh=o ah=a " +
    "uh=a wow=wau ooh=u yo=yu summer=sama winter=winta spring=sprin " +
    "autumn=otam season=sisn weather=weda clouds=klauds cloud=klaud " +
    "thunder=tanda lightning=laitnin rainbow=renbo sunrise=sanrais " +
    "sunset=sanse midnight=midnai beat=bit beats=bits rhythm=ridem " +
    "melody=melodi chorus=koras verse=vers rap=rep rapper=rapa band=ban " +
    "stage=stej concert=konser party=pari club=klab little=lito " +
    "notice=notis chance=chans choice=choys noise=noyz horse=hos " +
    "course=kos force=fos once=wans twice=twais piece=pis style=stail " +
    "cause=koz pause=poz space=spes grace=gres swing=swin string=strin " +
    "wing=win belong=bilon sound=saun sounds=sauns town=taun pray=pre " +
    "prayer=prea haven=hafn often=ofn wild=waild kind=kaind " +
    "blind=blaind sorry=sori worry=wori hurry=hari glory=glori " +
    "hello=helo goodbye=gudbai please=plis thank=tank thanks=tanks " +
    "scream=skrim stream=strim team=tim mean=min means=mins " +
    "meaning=minin clean=klin another=anada wonder=wanda tower=tawa " +
    "lonely=lonli homely=homli lovely=lufli surely=shuli quickly=kwikli " +
    "slowly=sloli hardly=hadli softly=sofli gently=jenli deeply=dipli " +
    "simply=simpli clearly=kliali nearly=niali secretly=sikreli " +
    "perfectly=perfekli completely=komplitli absolutely=absoluli " +
    "definitely=definetli honestly=onesli near=nia clear=klia dear=dia " +
    "deep=dip ever=eva lady=ledi alone=alon awake=awek asleep=aslip " +
    "afraid=afred scared=skead bored=bod tired=taiad excited=eksaid " +
    "nervous=nervus jealous=jelus proud=praud ashamed=ashemd " +
    "guilty=gilti confused=konfusd stuck=stak trapped=trapd hurt=her " +
    "hurting=herin healing=hilin whole=hol hungry=hangri thirsty=tersti " +
    "sick=sik healthy=helti numb=nam cruel=krul gentle=jento " +
    "fierce=fias brave=bref wicked=wikd holy=holi sacred=sekrd " +
    "cursed=kersd blessed=blesd desperate=despre hopeless=hoples " +
    "restless=resles reckless=rekles careless=keles fearless=fiales " +
    "heartless=hales mindless=mainles endless=enles timeless=taimles " +
    "worthless=wotles priceless=praisles famous=femus " +
    "mysterious=mistirus serious=sirius previous=privius obvious=obvius " +
    "curious=kyurius furious=fyurius glorious=glorius precious=preshus " +
    "conscious=konshus knock=nok knocking=nokin kicked=kikd kick=kik " +
    "kicking=kikin jump=jamp jumping=jampin jumped=jampd swim=swem " +
    "swimming=swimin swam=swem climb=klaim climbing=klaimin crawl=krol " +
    "crawling=krolin slide=slaid sliding=slaidin slip=slep " +
    "slipping=slipin slipped=slipd throw=tro throwing=troin threw=tru " +
    "thrown=tron catch=kach catching=kachin caught=kot drop=drap " +
    "dropping=dropin dropped=dropd shoot=shu shooting=shuin shot=sho " +
    "steal=stil stealing=stilin stole=stol stolen=stoln hide=haid " +
    "hiding=haidin hid=hed hidden=hidn seek=sik seeking=sikin " +
    "sought=sot chase=ches chasing=chesin chased=chesd escape=eskep " +
    "escaping=eskepin escaped=eskepd won=wan winning=winin win=wen " +
    "beating=bitin touch=tach touching=tachin touched=tachd kiss=kis " +
    "kissing=kisin kissed=kisd hug=hag hugging=hagin hugged=hagd " +
    "embrace=embres wrap=rap wrapping=rapin wrapped=rapd squeeze=skwiz " +
    "squeezing=skwizin grab=greb grabbing=grabin grabbed=grabd " +
    "swear=swea swearing=sweain swore=swor sworn=swon " +
    "promising=promisin promised=promisd beg=bag begging=begin " +
    "begged=begd bleed=blid bleeding=blidin bled=blad drown=draun " +
    "drowning=draunin drowned=draund suffer=safa suffering=safarin " +
    "suffered=safad struggle=strago struggling=stragolin " +
    "survive=servaif surviving=servaifin surrender=sarenda " +
    "surrendering=sarendarin forgive=fogif forgiving=fogifin " +
    "forgave=fogef forgiven=fogifn betray=bitre betrayed=bitred " +
    "betrayal=bitrel trusting=trasin trusted=trasd doubt=dau " +
    "doubting=dauin wondering=wandarin wondered=wandad imagine=imajin " +
    "imagining=imajinin imagined=imajind pretend=priten " +
    "pretending=pritenin pretended=pritend exist=eksis existing=eksisin " +
    "existed=eksisd belonging=bilonin become=bikam becoming=bikamin " +
    "became=bikem remain=rimen remaining=rimenin remained=rimend " +
    "respect=rispek protect=protek protecting=protekin " +
    "protected=protekd defend=difen defending=difenin attack=atak " +
    "attacking=atakin control=kontrol controlling=kontrolin " +
    "release=rilis releasing=rilisin released=rilisd whisper=wispa " +
    "whispering=wisparin whispered=wispad shout=shau shouting=shauin " +
    "shouted=shaud yell=yel yelling=yelin yelled=yeld confess=konfes " +
    "confessing=konfesin confessed=konfesd silent=sailen " +
    "silence=sailens louder=lauda loudest=laudes answer=ansa " +
    "answering=ansarin answered=ansad question=kweshun reply=ripla " +
    "respond=rispon explain=eksplen describe=diskriab express=ekspres " +
    "repeat=ripit repeating=ripitin lover=luva lovers=luvas " +
    "partner=patna husband=hasban wife=waif fiance=fiansei " +
    "boyfriend=bofren girlfriend=galfren darling=dalin honey=hani " +
    "sweetheart=switha neighbor=neba neighbour=neba stranger=strenja " +
    "enemy=enemi enemies=enemis soldier=solja soldiers=soljas " +
    "captain=kaptn general=jenral doctor=dokta teacher=ticha " +
    "preacher=pricha master=masta mister=mista saint=sent sinner=sina " +
    "killer=kila savior=sevia saviour=sevia winner=wina loser=lusa " +
    "fighter=faita dancer=dansa singer=singa player=plea dreamer=drima " +
    "believer=biliva thief=tif thieves=tifs ghost=gos ghosts=goss " +
    "spirit=spiri spirits=spiris monster=monsta monsters=monstas " +
    "demon=dimon demons=dimons bird=bed birds=beds wolf=wuf wolves=wufs " +
    "lion=laion tiger=taiga bear=bea snake=snek snakes=sneks " +
    "dragon=dragn dragons=dragns butterfly=batafla butterflies=bataflas " +
    "cat=kat cats=kats dog=dag dogs=dags island=ailan desert=deser " +
    "jungle=jango beach=bich shore=sho coast=kos valley=vali hill=hil " +
    "hills=hils cliff=klif cave=kef rock=rok rocks=roks stone=ston " +
    "stones=stons dust=das dirt=der mud=mad sand=san grass=gras " +
    "seed=sid seeds=sids root=ru roots=rus fate=fet destiny=destni " +
    "luck=lak lucky=laki fortune=fochun magic=majik magical=majiko " +
    "miracle=mirako mystery=mistri wisdom=wizdom knowledge=nolej " +
    "lesson=lesn lessons=lesns mistake=mistek mistakes=misteks " +
    "regret=rigre regrets=rigres memory=memri memories=memris " +
    "history=histri future=fyucha past=pas present=presen " +
    "eternity=eterniti infinity=infiniti reality=rialiti fantasy=fantsi " +
    "illusion=ilyushun reflection=riflekshun mirror=mira glass=glas " +
    "picture=pikcha pictures=pikchas photo=foto image=imej " +
    "vision=vishun visions=vishuns color=kala colour=kala colors=kalas " +
    "colours=kalas beauty=byuti silver=silva iron=aion steel=stil " +
    "dress=dres dressed=dresd shirt=sher pants=pans jacket=jake " +
    "coat=kot hat=ha mask=mas masked=masd naked=nekd bare=bea " +
    "faced=fesd scar=ska scars=skas wound=wun wounds=wuns wounded=wund " +
    "mark=mak marks=maks marked=makd sign=sain signs=sains signal=signo " +
    "breathe=brit breathing=britin breathed=britd swallow=swalo " +
    "swallowing=swaloin bite=bai biting=baitin bit=bi bitten=bitn " +
    "spit=spi spitting=spiin choke=chok choking=chokin choked=chokd " +
    "shake=shek shaking=shekin shook=shuk shaken=shekn tremble=trembo " +
    "trembling=trembolin freeze=friz freezing=frizin froze=fros " +
    "frozen=frosn melt=mel melting=melin melted=meld pour=po " +
    "pouring=poin poured=pod spill=spil spilling=spilin spilled=spild " +
    "sink=senk sinking=sinkin sank=senk sunk=sank float=flo " +
    "floating=floin spin=spen spinning=spinin spun=span twist=twis " +
    "twisting=twisin twisted=twisd bend=ben bending=benin bent=ben " +
    "stretch=strech stretching=strechin point=poin pointing=poinin " +
    "pointed=poind wipe=waip wiping=waipin wiped=waipd scratch=skrach " +
    "scratching=skrachin castle=kaso palace=palas temple=tempo " +
    "bridge=brij gate=get gates=gets fence=fens path=pat paths=pats " +
    "trail=trel track=trak corner=kona edge=ej border=boda limit=limi " +
    "bottom=botam top=tap center=senta centre=senta middle=mido " +
    "surface=safes beneath=binit horizon=horisn grave=gref graves=grefs " +
    "tomb=tum cross=kros altar=olta paradise=paradais " +
    "wonderland=wandalan kingdom=kingdam empire=empaia nation=neshun " +
    "sword=sod swords=sods shield=shild armor=ama armour=ama " +
    "weapon=wepn weapons=wepns bullet=bule bullets=bules bomb=bom " +
    "bombs=boms knife=naif blade=bled blades=bleds candle=kando " +
    "candles=kandos torch=toch flash=flas spark=spak sparks=spaks " +
    "smoke=smok ash=as ashes=ashs ruins=ruens wreck=rek wreckage=rekej " +
    "treasure=tresha treasures=treshas jewel=juel jewels=juels " +
    "pearl=pel pearls=pels clock=klok bell=bel bells=bels key=ki " +
    "keys=kis lock=lok locks=loks locked=lokd chains=chens rope=rop " +
    "ropes=rops wire=waia wires=waias strings=strins thread=tred " +
    "needle=nido cup=kap bottle=boto bottles=botos glasses=glases " +
    "medicine=medisin poison=poysn pill=pil pills=pils ink=enk " +
    "paper=pepa page=pej pages=pejs book=buk books=buks map=mep " +
    "compass=kampas flag=fleg flags=flegs wings=wins halo=helo " +
    "horns=hons cage=kej cages=kejs prison=prisn jail=jel trap=trep " +
    "traps=treps north=not south=sau east=is west=wes forward=fowad " +
    "backward=bakwad upward=apwad downward=daunwad beside=bisaid " +
    "front=fron food=fud bread=bred wine=wain beer=bia whiskey=wiski " +
    "whisky=wiski drinks=drins sweet=swit sweeter=swita sweetest=swites " +
    "bitter=bita sour=saua salt=sol salty=solti sugar=shuga fruit=fru " +
    "apple=apo cherry=cheri huge=hyuj tiny=taini wide=waid narrow=naro " +
    "thick=tik thin=tin heavy=hefi lighter=laita rightest=braites " +
    "brightest=braites bright=brai dim=dem faint=fen sharp=shap " +
    "rough=raf smooth=smu flat=fla round=raun straight=stret " +
    "crooked=krukd kinda=kainda sorta=soda dunno=dano lemme=lemi " +
    "gimme=gimi cmon=kmon imma=ima tryna=traina finna=fina wassup=wasap " +
    "suppose=sapos supposed=saposd interesting=intrestin " +
    "impossible=imposibo incredible=inkredibo unbelievable=anbilifabo " +
    "wonderful=wandafo amazing=amezin awesome=osom terrible=teribo " +
    "horrible=horibo powerful=pawafo grateful=grefo watchful=wochfo " +
    "faithful=feitfo cheerful=chirfo peaceful=pisfo playful=plefo " +
    "painful=penfo harmful=hamfo hopeful=hopfo thankful=tankfo " +
    "truthful=trutfo wasteful=westefo sinful=sinfo dreadful=dredfo " +
    "awful=ofo lawful=lofo unlawful=anlofo forgetful=fogefo " +
    "respectful=rispekfo disrespectful=disrispekfo regretful=rigrefo " +
    "neglectful=niglekfo unhappy=anhapi unkind=ankaind unfair=anfea " +
    "unknown=annon unbroken=anbrokn unspoken=anspokn " +
    "unforgiven=anfogifn unforgivable=anfogifabo " +
    "unforgettable=anfogetabo unstoppable=anstopabo " +
    "unbreakable=anbrekabo unconscious=ankonshus unaware=anawea " +
    "unable=anebo unwanted=anwaned unloved=anlufd untouched=antachd " +
    "untold=antold unreal=anril unfinished=anfinishd uncertain=ansertn " +
    "reborn=ribon remade=rimed return=riter returning=riterin " +
    "returned=riterd revenge=rivenj rebel=rebo refuse=rifyus " +
    "refusing=rifyusin refused=rifyusd reject=rijek rejecting=rijekin " +
    "rejected=rijekd disappear=disapia disappearing=disapirin " +
    "disappeared=disapiad discover=diskova discovering=diskovarin " +
    "discovered=diskovad disguise=disgais disguised=disgaisd " +
    "destruction=distrakshun connect=konek connecting=konekin " +
    "connected=konekd connection=konekshun disconnect=diskonek " +
    "disconnected=diskonekd fog=fag foggy=fogi mist=mis misty=misti " +
    "haze=hez hazy=hezi frost=fros frosty=frosti boiling=boilin " +
    "flooding=fladin flood=flad floods=flads earthquake=ertwek " +
    "volcano=volkeno blizzard=blizad hurricane=hariken tornado=tonedo " +
    "typhoon=taifun tsunami=sunami hey=he woah=woa whoa=woa da=de la=le " +
    "ive=aiv mr=mista mrs=misis fun=fan funny=fani great=gre such=sach " +
    "kinds=kains mental=mentol chubby=chabi fiend=fin speed=spid " +
    "speeding=spidin burnin=bernin havin=hefin jumpin=jampin " +
    "shootin=shutin stoppin=stopin disturbin=disterbin " +
    "disturbing=disterbin travelin=travalen traveling=travelin " +
    "travelling=travelin creatin=krieitin join=jon joining=joinin " +
    "joined=joind implode=implod imploding=implodin explode=eksplod " +
    "explodes=eksplods exploding=eksplodin request=rikwes " +
    "requesting=rikwesin foot=fut feet=fit atom=etom atoms=etoms " +
    "degrees=digris degree=digri ecstasy=ekstasi british=britis " +
    "tribes=traibs tribe=traib worlds=werlds worms=werms worm=werm " +
    "portals=potals portal=potal metaverse=metavers vrchat=viarchat " +
    "ali=eli as=ez happening=hapenin happened=hapend happens=hapens " +
    "happen=hapen reaction=riakshon reactions=riakshons some=sam " +
    "somehow=samhau someday=samde anymore=enimor alright=olrai " +
    "whatever=wateva well=wel else=els stuff=staf type=taip types=taips " +
    "form=fom forms=foms total=totol totally=totoli amount=amaun " +
    "number=namba numbers=nambas matter=mata matters=matas " +
    "single=singol passion=pashon passionate=pashonet patient=peshent " +
    "patience=peshens longing=langin anguish=angwis grieving=grivin " +
    "worried=warid selfish=selfis shame=shem shock=shak shocked=shakd " +
    "giddy=gidi comfy=kamfi cozy=kozi hollow=halo stupid=stupet " +
    "obviously=abviusli fine=fain sexy=seksi naughty=noti nice=nais " +
    "grand=gren grueling=grulin meet=mit meets=mits meeting=mitin " +
    "pass=pes passes=peses passing=pesin crash=kras crashes=krases " +
    "crashing=krasin staring=sterin stare=ster apologize=apolojais " +
    "apologizing=apolojaisin burns=berns hurts=herts cares=kers " +
    "care=ker caring=kerin cover=kava covers=kavas covering=kaverin " +
    "blows=blos blow=blo blowing=bloin fills=fels fill=fel " +
    "filling=felin drops=draps flip=flep flips=fleps flipping=flepin " +
    "pound=paun pounding=paunin moan=mon moaning=monin spreads=spreds " +
    "spread=spred spreading=spredin tickles=tekols tickle=tekol " +
    "tickling=tekolin riding=raidin ride=raid rides=raids " +
    "gliding=glaidin glide=glaid swinging=swingin checking=chekin " +
    "check=chek talked=tokd paint=pen paints=pens painting=penin " +
    "dig=deg digs=degs digging=degin gather=gada gathers=gadas " +
    "gathering=gaderin forge=forj forging=forjin hone=hon honing=honin " +
    "overhear=ovahir overcast=ovakes surprise=suprais " +
    "surprised=supraisd drinkin=drenkin screamin=skrimin " +
    "screaming=skrimin thinkin=tinkin wonderin=wanderin comin=kamin " +
    "singin=sengin jinglin=jenglin jingling=jenglin tingling=tenglin " +
    "hissing=hesin prowlin=praulin prowling=praulin clawin=klawin " +
    "clawing=klawin slurping=slerpin brain=bren brains=brens brawn=bron " +
    "shoulder=sholda shoulders=sholdas cheeks=chiks cheek=chik " +
    "sweat=swet sweating=swetin mustache=mustash art=at arts=ats " +
    "artist=atist canvas=kanvas brush=bras strokes=stroks stroke=strok " +
    "craft=kraf crafting=krafin print=pren lengths=lengs length=leng " +
    "measures=meshas measure=mesha hardest=hades harder=hada " +
    "daylight=delai december=desemba november=novemba months=mans " +
    "month=man til=tel birthday=bertde morn=mon lake=lek lakes=leks " +
    "vines=vains vine=vain tethered=tederd fairyland=ferilen " +
    "wintry=wintri fireplace=fairples coffee=kofi cream=krim pie=pai " +
    "pumpkin=pamkin chestnuts=chesnats chestnut=chesnat meat=mit " +
    "nut=nat nuts=nats juicy=jusi santa=senta claus=klos daddy=dadi " +
    "girls=gerls bro=bru warrior=waria warriors=warias farmer=fama " +
    "currier=kuria ives=aivs creeper=kripa creepers=kripas pro=pru " +
    "promises=promeses letters=letas toys=tois toy=toi sleigh=sle " +
    "list=les movie=muvi movies=muvis sack=sek feather=feda " +
    "feathers=fedas shovel=shavel pickaxe=pikaks torchlight=tochlai " +
    "bolt=bol bolts=bols health=helf bar=ba bars=bas heads=heds " +
    "stick=stek sticks=steks pout=pau pouting=pauin pop=pap pops=paps " +
    "popping=papin snuggled=snagld snuggle=snagl fucking=fakin fuck=fak " +
    "fucked=fakd shit=she damn=dem ass=es cock=kak fat=fet aww=aw " +
    "eah=ea ey=ei yea=ye ho=hu hoo=hu huh=ha yoo=yu ting=teng rosy=rozi " +
    "favorite=favrit tardy=tadi tone=ton tones=tons mlg=emelji " +
    "training=trenin train=tren task=tesk tasks=tesks goodness=gudnes " +
    "sake=sek twenty=tweni gon=gan"
  )
    .split(" ")
    .map((entry) => entry.split("=") as [string, string]),
);
