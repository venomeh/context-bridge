// Synthetic fixtures shaped like the real thing.
//
// Deliberately NOT slices of Bubble's own bundle: this repo should not redistribute
// their code, and a synthetic fixture tests the parser rather than one captured build.

/** A run.js-shaped bundle: minified JS carrying the code table and two element defs. */
export const RUN_JS = `
${'/*'} pad ${'*/'}${'x'.repeat(1200)}
var STATE_NOT_READY={},PADDING_VERSION=2,PROP_CODES={display_sender_name:"d7",list_id:"li",
deleted:"del",email_address:"ea",action_id:"ai",description:"d3",label:"lab",user_name:"un",
floating:"f7",formatting_type:"ft",poststripeauth:"p8",image_pressed:"ip",center_background:"cb",
image_normal:"i9",image_hover:"ih",descending:"d2",password2:"p2",text:"3",height:"h",width:"w",
left:"l",top:"t",zindex:"z",font_size:"fs",is_visible:"iv",border_roundness:"br",font_color:"fc",
background_style:"bas",bgcolor:"bgc",font_alignment:"fa",group_type:"gt",icon:"9i",bold:"b",
data_source:"ds",border_style:"bos",border_color:"bc",border_width:"bw",placeholder:"ps",
content_format:"cf",floating_reference:"3f",vertical_centering:"vc",custom_id:"ci",default:"d1",
icon_color:"ic",mandatory:"1m",rows:"rs",choices:"ch",contents:"ct",html:"ht",value:"v",
element_id:"ei",stretch_or_rescale:"2f",linktype:"1l",page:"pa",open_in_new_tab:"o9",
elements:"el",style:"s1",name:"nm",properties:"p",entries:"e",args:"a",condition:"c",next:"n"},
OTHER_THING={};
make_element("Text",{category:"visual elements",glyph_id:"text",field_names:{text:{default:"…edit me…"},
editor_preview_text:{no_states:!0},stretch_to_fit:{default:!1},tag_type:{no_states:!0}},styleable_properties:{}});
make_element("Video",{category:"visual elements",glyph_id:"video",field_names:{video_source:{default:"youtube",no_states:!0},
video_id:{},autoplay:{default:!1},loop:{default:!1}},can_fix_aspect_ratio(){return!0}});
${'x'.repeat(400)}
`;

/** A dynamic.js-shaped bundle carrying app settings. */
export const DYNAMIC_JS = `
window.app = JSON.parse('{"settings":{"style_version":5,"default_styles":{"Text":"Text_body_16_","Video":"Video_standard_video_","Group":"Group_transparent_","Link":"Link_link_light_primary_"}}}');
`;

/** An export-shaped document. Note properties render under LONG names, as Bubble does. */
export const EXPORT_DOC = {
  app_version: 'test',
  uid_counter: 10000000,
  _index: {
    id_to_path: {
      pg1: '%p3.PAGEA',
      el1: '%p3.PAGEA.%el.GRPA',
      el2: '%p3.PAGEA.%el.GRPA.%el.TXTA',
    },
  },
  styles: {
    Text_body_16_: { id: 'Text_body_16_', type: 'Text', properties: { font_size: 16, font_color: '#111' } },
  },
  pages: {
    PAGEA: {
      id: 'pg1',
      name: 'home',
      type: 'Page',
      properties: { width: 1200 },
      workflows: {},
      elements: {
        GRPA: {
          id: 'el1',
          name: 'G: wrapper',
          type: 'Group',
          properties: { container_layout: 'column', order: 1 },
          elements: {
            TXTA: {
              id: 'el2',
              name: 'txt: headline',
              type: 'Text',
              style: 'Text_body_16_',
              properties: {
                // the export renders %3 as `text` and %fs as `font_size`
                text: { entries: { 0: 'hello' }, type: 'TextExpression' },
                font_size: 16,
                order: 1,
                padding_left: 8,
              },
            },
          },
        },
      },
    },
  },
};
